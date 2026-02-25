const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const { 
  getAllKlines, 
  getTickers, 
  getAllMultiTimeframeKlines,
  SYMBOLS_54 
} = require('./src/gateio');
const { scanAllSymbols, CONFIG } = require('./src/strategy');
const { scanAllSymbolsMTF, MTF_SCANNER_CONFIG } = require('./src/mtfScanner');
const { 
  scanAllSymbolsV2, 
  analyzeHTFBias, 
  environmentCheckV2, 
  analyzeLTFConfirmation,
  CONFIG: CONFIG_V2 
} = require('./src/strategy_v2');
const { logger, metrics } = require('./src/utils/logger');
const {
  InputValidator,
  withRetry,
  RateLimiter,
  IdempotencyChecker,
  sanitizeSensitiveData,
  TimeoutError,
  RateLimitError,
  ValidationError
} = require('./src/utils/errors');

const app = express();
const PORT = process.env.PORT || 3001;

// 中间件
app.use(cors());
app.use(express.json());

// 请求日志中间件
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] || logger.generateTraceId();
  req.traceId = traceId;

  logger.info('Request started', {
    trace_id: traceId,
    method: req.method,
    path: req.path,
    query: sanitizeSensitiveData(req.query),
    ip: req.ip
  });

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    metrics.observe('http_request_duration_seconds', duration / 1000, {
      method: req.method,
      path: req.path,
      status: res.statusCode
    });

    logger.info('Request completed', {
      trace_id: traceId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration
    });
  });

  next();
});

// 限流器实例
const scanRateLimiter = new RateLimiter({
  windowMs: 60 * 60 * 1000, // 1小时
  maxRequests: 10 // 每小时最多10次
});

const globalRateLimiter = new RateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 100 // 全系统每小时100次
});

// 幂等检查器
const scanIdempotency = new IdempotencyChecker({
  windowMs: 4 * 60 * 60 * 1000 // 4小时
});

// 数据存储
let latestSignals = [];
let latestFiltered = [];
let latestKlines = {};
let latestTickers = {};
let scanHistory = [];
let lastScanTime = null;
let lastKlineUpdateTime = null;
let dataHealthStatus = 'HEALTHY';

// 扫描状态跟踪
let scanStatus = {
  status: 'IDLE',
  progress: 0,
  total: SYMBOLS_54.length,
  processed: 0,
  startTime: null,
  endTime: null,
  estimatedEndTime: null,
  currentSymbol: null,
  message: ''
};

// 扫描日志
let scanLogs = [];
const MAX_LOGS = 10;

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const KLINES_FILE = path.join(DATA_DIR, 'klines.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const LOGS_FILE = path.join(DATA_DIR, 'scanLogs.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 加载历史数据
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      scanHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      logger.info('History loaded', { count: scanHistory.length });
    }
    if (fs.existsSync(LOGS_FILE)) {
      scanLogs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
      logger.info('Scan logs loaded', { count: scanLogs.length });
    }
  } catch (error) {
    logger.error('Error loading history', { error: error.message });
  }
}

// 更新数据健康状态
function updateDataHealth() {
  if (!lastKlineUpdateTime) {
    dataHealthStatus = 'DEAD';
    return;
  }

  const now = Date.now();
  const age = now - lastKlineUpdateTime;

  if (age < CONFIG.DATA_HEALTHY_THRESHOLD) {
    dataHealthStatus = 'HEALTHY';
  } else if (age < CONFIG.DATA_STALE_THRESHOLD) {
    dataHealthStatus = 'STALE';
  } else {
    dataHealthStatus = 'DEAD';
  }

  // 记录指标
  metrics.gauge('data_health_status', dataHealthStatus === 'HEALTHY' ? 1 : dataHealthStatus === 'STALE' ? 0.5 : 0);
}

// 获取数据健康信息
function getDataHealthInfo() {
  updateDataHealth();

  const now = Date.now();
  const age = lastKlineUpdateTime ? now - lastKlineUpdateTime : null;

  return {
    status: dataHealthStatus,
    last_update: lastKlineUpdateTime ? new Date(lastKlineUpdateTime).toISOString() : null,
    age_ms: age,
    age_formatted: age ? formatDuration(age) : 'N/A',
    thresholds: {
      healthy_ms: CONFIG.DATA_HEALTHY_THRESHOLD,
      stale_ms: CONFIG.DATA_STALE_THRESHOLD
    }
  };
}

// 格式化时长
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}小时${minutes % 60}分钟`;
  }
  return `${minutes}分钟`;
}

// 格式化扫描耗时
function formatScanDuration(startTime, endTime) {
  const duration = endTime - startTime;
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}分${remainingSeconds}秒`;
  }
  return `${seconds}秒`;
}

// 更新扫描状态
function updateScanStatus(newStatus) {
  scanStatus = { ...scanStatus, ...newStatus };
}

// 记录扫描日志
function recordScanLog(result) {
  const log = {
    id: Date.now().toString(),
    startTime: scanStatus.startTime,
    endTime: scanStatus.endTime || new Date().toISOString(),
    duration: scanStatus.startTime && scanStatus.endTime
      ? formatScanDuration(new Date(scanStatus.startTime), new Date(scanStatus.endTime))
      : '未知',
    totalSymbols: SYMBOLS_54.length,
    signalsGenerated: result.signals?.length || 0,
    signalsFiltered: result.filtered?.length || 0,
    ratingDistribution: result.signals?.reduce((acc, s) => {
      acc[s.rating] = (acc[s.rating] || 0) + 1;
      return acc;
    }, {}),
    filterReasons: result.filtered?.reduce((acc, f) => {
      acc[f.reason] = (acc[f.reason] || 0) + 1;
      return acc;
    }, {}),
    timestamp: new Date().toISOString()
  };

  scanLogs.unshift(log);
  if (scanLogs.length > MAX_LOGS) {
    scanLogs = scanLogs.slice(0, MAX_LOGS);
  }

  // 保存日志
  try {
    fs.writeFileSync(LOGS_FILE, JSON.stringify(scanLogs, null, 2));
    logger.info('Scan log recorded', { logId: log.id });
  } catch (error) {
    logger.error('Error saving scan logs', { error: error.message });
  }

  // 记录指标
  metrics.increment('signals_generated_total', {}, log.signalsGenerated);
  metrics.increment('signals_filtered_total', {}, log.signalsFiltered);
  for (const [rating, count] of Object.entries(log.ratingDistribution)) {
    metrics.increment('signals_by_rating', { rating }, count);
  }
  for (const [reason, count] of Object.entries(log.filterReasons)) {
    metrics.increment('signals_filtered_by_reason', { reason }, count);
  }
}

// 更新信号状态（TTL检查等）
function updateSignalStatuses() {
  const now = Date.now();
  let expiredCount = 0;

  latestSignals = latestSignals.map(signal => {
    const signalTime = new Date(signal.timestamp).getTime();
    const age = now - signalTime;

    // 检查是否过期
    if (age > CONFIG.SIGNAL_TTL_MS) {
      expiredCount++;
      return {
        ...signal,
        status: 'EXPIRED',
        status_desc: '信号已过期（超过4小时）',
        expires_in_minutes: 0,
        invalid_reason: 'TTL_EXPIRED',
        suggested_action: '放弃该信号，等待新的扫描结果'
      };
    }

    // 更新剩余时间
    const expiresIn = Math.floor((CONFIG.SIGNAL_TTL_MS - age) / 60000);

    // 如果当前是ACTIVE状态，保持ACTIVE
    if (signal.status === 'ACTIVE' || signal.status === 'PENDING') {
      return {
        ...signal,
        expires_in_minutes: expiresIn
      };
    }

    return signal;
  });

  if (expiredCount > 0) {
    logger.info('Signal status updated', { expiredCount });
    saveData();
  }
}

// 保存数据
function saveData() {
  try {
    // 统计V2信号类型
    const tradableCount = latestSignals.filter(s => s.signal_type === 'TRADABLE' || !s.signal_type).length;
    const candidateCount = latestSignals.filter(s => s.signal_type === 'CANDIDATE').length;
    
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify({
      scan_time: lastScanTime,
      total_signals: latestSignals.length,
      total_filtered: latestFiltered.length,
      tradable_signals: tradableCount,
      candidate_signals: candidateCount,
      symbols_scanned: SYMBOLS_54.length,
      symbols_monitored: SYMBOLS_54.length,
      symbols_enabled: latestSignals.length,
      timeframe: '4H',
      data_source: 'Gate.io API',
      data_health: getDataHealthInfo(),
      signals: latestSignals,
      filtered: latestFiltered,
      strategy_version: 'V2.0'
    }, null, 2));

    fs.writeFileSync(KLINES_FILE, JSON.stringify(latestKlines, null, 2));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(scanHistory, null, 2));

    logger.info('Data saved', {
      signals: latestSignals.length,
      tradable: tradableCount,
      candidates: candidateCount,
      filtered: latestFiltered.length
    });
  } catch (error) {
    logger.error('Error saving data', { error: error.message });
  }
}

// 执行扫描（带进度跟踪和错误处理）
async function performScan(userId = 'anonymous') {
  const op = logger.startOperation('scan_signals', { userId });

  // 检查限流
  try {
    scanRateLimiter.checkAndRecord(userId);
    globalRateLimiter.checkAndRecord('global');
  } catch (error) {
    logger.warn('Rate limit exceeded', { userId, error: error.message });
    op.end('rate_limited');
    throw error;
  }

  // 检查幂等
  const scanKey = scanIdempotency.generateKey(userId, Date.now().toString().slice(0, 10));
  const idemCheck = scanIdempotency.checkAndMark(scanKey);
  if (!idemCheck.firstTime) {
    logger.warn('Duplicate scan request', { userId, scanKey });
    op.end('duplicate');
    return {
      success: false,
      message: '扫描请求过于频繁，请稍后再试',
      duplicate: true
    };
  }

  // 初始化扫描状态
  updateScanStatus({
    status: 'RUNNING',
    progress: 0,
    processed: 0,
    total: SYMBOLS_54.length,
    startTime: new Date().toISOString(),
    endTime: null,
    estimatedEndTime: new Date(Date.now() + 30000).toISOString(),
    currentSymbol: null,
    message: '正在初始化...'
  });

  logger.info('Scan started', { userId, totalSymbols: SYMBOLS_54.length });

  try {
    // 阶段1：获取K线数据（带重试）
    updateScanStatus({
      progress: 5,
      message: '正在获取K线数据...'
    });

    logger.info('Fetching klines', { symbolCount: SYMBOLS_54.length });

    latestKlines = await withRetry(
      () => getAllKlines('4h', 100),
      {
        maxRetries: 3,
        retryDelay: 1000,
        timeout: 30000,
        onRetry: (attempt, maxRetries, error) => {
          logger.warn('Retrying klines fetch', { attempt, maxRetries, error: error.message });
        }
      }
    );

    lastKlineUpdateTime = Date.now();
    logger.info('Klines fetched', { count: Object.keys(latestKlines).length });

    updateScanStatus({
      progress: 30,
      message: '正在获取实时价格...'
    });

    // 阶段2：获取实时价格
    latestTickers = await withRetry(
      () => getTickers(),
      {
        maxRetries: 3,
        retryDelay: 1000,
        timeout: 10000
      }
    );

    logger.info('Tickers fetched');

    // 阶段3：策略分析（使用V2）
    updateScanStatus({
      progress: 40,
      message: '正在进行V2策略分析...'
    });

    // 使用V2策略扫描
    const v2Result = scanAllSymbolsV2(latestKlines, latestTickers, scanHistory);
    
    // 合并信号（tradable + candidate）
    const signals = [...v2Result.tradable_signals, ...v2Result.candidate_signals];
    const filtered = v2Result.filtered;

    updateScanStatus({
      progress: 90,
      processed: SYMBOLS_54.length,
      message: `分析完成，${v2Result.tradable_signals.length}个可交易信号，${v2Result.candidate_signals.length}个候选信号`
    });

    latestSignals = signals;
    latestFiltered = filtered;

    updateScanStatus({
      progress: 95,
      message: '正在保存结果...'
    });

    lastScanTime = new Date().toISOString();

    // 添加到历史记录
    scanHistory.unshift({
      time: lastScanTime,
      signal_count: latestSignals.length,
      filtered_count: latestFiltered.length,
      signals: latestSignals.map(s => ({
        symbol: s.symbol,
        direction: s.direction,
        rating: s.rating,
        rrr: s.rrr,
        score: s.score
      }))
    });

    if (scanHistory.length > 100) {
      scanHistory = scanHistory.slice(0, 100);
    }

    // 保存数据
    saveData();

    // 记录扫描日志
    recordScanLog({ signals: latestSignals, filtered: latestFiltered });

    // 完成扫描
    updateScanStatus({
      status: 'IDLE',
      progress: 100,
      processed: SYMBOLS_54.length,
      endTime: new Date().toISOString(),
      currentSymbol: null,
      message: `扫描完成，发现 ${latestSignals.length} 个信号`
    });

    logger.info('Scan completed', {
      signals: latestSignals.length,
      filtered: latestFiltered.length,
      duration: scanStatus.startTime && scanStatus.endTime
        ? new Date(scanStatus.endTime) - new Date(scanStatus.startTime)
        : null
    });

    op.end('success', {
      signals: latestSignals.length,
      filtered: latestFiltered.length
    });

    return {
      success: true,
      signal_count: latestSignals.length,
      filtered_count: latestFiltered.length,
      scan_time: lastScanTime
    };
  } catch (error) {
    logger.error('Scan failed', { error: error.message, stack: error.stack });

    updateScanStatus({
      status: 'IDLE',
      progress: 0,
      endTime: new Date().toISOString(),
      message: `扫描失败: ${error.message}`
    });

    op.end('error', { error: error.message });

    throw error;
  }
}

// API路由

// 获取扫描状态
app.get('/api/scan/status', (req, res) => {
  const elapsed = scanStatus.startTime
    ? Date.now() - new Date(scanStatus.startTime).getTime()
    : 0;

  const estimatedRemaining = scanStatus.status === 'RUNNING' && scanStatus.estimatedEndTime
    ? Math.max(0, new Date(scanStatus.estimatedEndTime).getTime() - Date.now())
    : 0;

  res.json({
    ...scanStatus,
    elapsed,
    elapsedFormatted: formatDuration(elapsed),
    estimatedRemaining,
    estimatedRemainingFormatted: formatDuration(estimatedRemaining)
  });
});

// 获取扫描日志
app.get('/api/scan/logs', (req, res) => {
  res.json({
    logs: scanLogs,
    total: scanLogs.length
  });
});

// 获取当前信号
app.get('/api/signals', (req, res) => {
  const op = logger.startOperation('get_signals', { query: req.query });

  try {
    updateSignalStatuses();

    const { status, rating, direction } = req.query;
    let signals = latestSignals;

    // 按状态过滤
    if (status) {
      signals = signals.filter(s => s.status === status);
    }
    if (rating) {
      signals = signals.filter(s => s.rating === rating);
    }
    if (direction) {
      signals = signals.filter(s => s.direction === direction);
    }

    op.end('success', { count: signals.length });

    // 统计V2信号类型
    const tradableCount = latestSignals.filter(s => s.signal_type === 'TRADABLE' || !s.signal_type).length;
    const candidateCount = latestSignals.filter(s => s.signal_type === 'CANDIDATE').length;

    res.json({
      scan_time: lastScanTime,
      total_signals: latestSignals.length,
      total_filtered: latestFiltered.length,
      tradable_signals: tradableCount,
      candidate_signals: candidateCount,
      symbols_scanned: SYMBOLS_54.length,
      symbols_monitored: SYMBOLS_54.length,
      symbols_enabled: latestSignals.length,
      timeframe: '4H',
      data_source: 'Gate.io API',
      data_health: getDataHealthInfo(),
      strategy_version: 'V2.0',
      signals,
      filtered: latestFiltered
    });
  } catch (error) {
    logger.error('Error getting signals', { error: error.message });
    op.end('error');
    res.status(500).json({ error: error.message });
  }
});

// 获取K线数据
app.get('/api/klines/:symbol', (req, res) => {
  try {
    const { symbol } = req.params;
    InputValidator.validateSymbol(symbol);

    const klines = latestKlines[symbol];

    if (klines) {
      res.json(klines);
    } else {
      res.status(404).json({ error: 'Symbol not found' });
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// 获取所有K线数据
app.get('/api/klines', (req, res) => {
  res.json(latestKlines);
});

// 获取扫描历史
app.get('/api/history', (req, res) => {
  res.json({
    last_scan: lastScanTime,
    history: scanHistory
  });
});

// 手动触发扫描
app.post('/api/scan', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'anonymous';

  // 如果正在扫描，返回当前状态
  if (scanStatus.status === 'RUNNING') {
    return res.json({
      success: false,
      message: '扫描正在进行中',
      status: scanStatus
    });
  }

  try {
    // 开始扫描
    const result = await performScan(userId);
    res.json(result);
  } catch (error) {
    if (error instanceof RateLimitError) {
      res.status(429).json({
        success: false,
        error: error.message,
        code: error.code,
        remaining: scanRateLimiter.getRemaining(userId)
      });
    } else {
      logger.error('Scan endpoint error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// MTF扫描（多时间框架）
app.post('/api/scan/mtf', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'anonymous';
  
  // 如果正在扫描，返回当前状态
  if (scanStatus.status === 'RUNNING') {
    return res.json({
      success: false,
      message: '扫描正在进行中',
      status: scanStatus
    });
  }
  
  const op = logger.startOperation('mtf_scan', { userId });
  
  try {
    // 限流检查
    if (!scanRateLimiter.check(userId)) {
      throw new RateLimitError('Scan rate limit exceeded');
    }
    
    updateScanStatus({
      status: 'RUNNING',
      progress: 0,
      processed: 0,
      total: SYMBOLS_54.length,
      startTime: new Date().toISOString(),
      message: '正在初始化MTF扫描...'
    });
    
    logger.info('MTF Scan started', { userId, totalSymbols: SYMBOLS_54.length });
    
    // 阶段1: 获取多时间框架数据
    updateScanStatus({
      progress: 10,
      message: '正在获取多时间框架数据 (4H/15M/1M)...'
    });
    
    const mtfData = await withRetry(
      () => getAllMultiTimeframeKlines(['4h', '15m', '1m']),
      {
        maxRetries: 3,
        retryDelay: 2000,
        timeout: 120000,
        onRetry: (attempt, maxRetries, error) => {
          logger.warn('Retrying MTF data fetch', { attempt, maxRetries, error: error.message });
        }
      }
    );
    
    logger.info('MTF data fetched', { 
      symbols: Object.keys(mtfData).length,
      timeframes: ['4h', '15m', '1m']
    });
    
    // 阶段2: 获取实时价格
    updateScanStatus({
      progress: 30,
      message: '正在获取实时价格...'
    });
    
    const tickers = await getTickers();
    
    // 阶段3: MTF策略分析
    updateScanStatus({
      progress: 40,
      message: '正在进行MTF策略分析 (三层对齐/扫荡/高二低二)...'
    });
    
    const scanHistory = latestSignals.map(s => ({
      symbol: s.symbol,
      timestamp: s.timestamp
    }));
    
    const result = await scanAllSymbolsMTF(mtfData, tickers, scanHistory);
    
    // 更新信号
    latestSignals = result.signals;
    latestFiltered = result.filtered;
    lastScanTime = new Date().toISOString();
    
    // 记录扫描日志
    recordScanLog({ 
      signals: latestSignals, 
      filtered: latestFiltered,
      scanType: 'MTF'
    });
    
    // 完成扫描
    updateScanStatus({
      status: 'IDLE',
      progress: 100,
      processed: SYMBOLS_54.length,
      endTime: new Date().toISOString(),
      message: `MTF扫描完成，发现 ${result.signals.length} 个信号 (过滤 ${result.filtered.length} 个)`
    });
    
    logger.info('MTF Scan completed', {
      signals: result.signals.length,
      filtered: result.filtered.length,
      errors: result.errors.length
    });
    
    op.end('success', {
      signals: result.signals.length,
      filtered: result.filtered.length
    });
    
    res.json({
      success: true,
      signal_count: result.signals.length,
      filtered_count: result.filtered.length,
      error_count: result.errors.length,
      scan_type: 'MTF',
      scan_time: lastScanTime,
      mtf_config: {
        timeframes: MTF_SCANNER_CONFIG.TIMEFRAMES,
        alignment_gate: MTF_SCANNER_CONFIG.ALIGNMENT_GATE,
        sweep_required: MTF_SCANNER_CONFIG.SWEEP_REQUIRED,
        hilo_required: MTF_SCANNER_CONFIG.HILO_REQUIRED
      }
    });
    
  } catch (error) {
    logger.error('MTF Scan failed', { error: error.message, stack: error.stack });
    
    updateScanStatus({
      status: 'IDLE',
      progress: 0,
      endTime: new Date().toISOString(),
      message: `MTF扫描失败: ${error.message}`
    });
    
    op.end('error', { error: error.message });
    
    if (error instanceof RateLimitError) {
      res.status(429).json({
        success: false,
        error: error.message,
        code: error.code
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// 获取币种列表
app.get('/api/symbols', (req, res) => {
  res.json({
    count: SYMBOLS_54.length,
    symbols: SYMBOLS_54,
    enabled_count: latestSignals.length
  });
});

// 获取统计信息
app.get('/api/stats', (req, res) => {
  const ratingCounts = { S: 0, A: 0, B: 0, C: 0 };
  const directionCounts = { LONG: 0, SHORT: 0 };
  const statusCounts = { ACTIVE: 0, ENTERED: 0, EXPIRED: 0, INVALIDATED: 0 };

  latestSignals.forEach(s => {
    ratingCounts[s.rating]++;
    directionCounts[s.direction]++;
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  });

  const avgRrr = latestSignals.length > 0
    ? (latestSignals.reduce((sum, s) => sum + s.rrr, 0) / latestSignals.length).toFixed(2)
    : 0;

  const avgScore = latestSignals.length > 0
    ? (latestSignals.reduce((sum, s) => sum + s.score, 0) / latestSignals.length).toFixed(1)
    : 0;

  res.json({
    last_scan: lastScanTime,
    total_signals: latestSignals.length,
    total_filtered: latestFiltered.length,
    symbols_scanned: SYMBOLS_54.length,
    symbols_monitored: SYMBOLS_54.length,
    symbols_enabled: latestSignals.length,
    timeframe: '4H',
    data_source: 'Gate.io API',
    data_health: getDataHealthInfo(),
    rating_distribution: ratingCounts,
    direction_distribution: directionCounts,
    status_distribution: statusCounts,
    avg_rrr: avgRrr,
    avg_score: avgScore
  });
});

// 健康检查
app.get('/api/health', (req, res) => {
  updateDataHealth();

  res.json({
    status: dataHealthStatus === 'HEALTHY' ? 'ok' : 'degraded',
    data_health: getDataHealthInfo(),
    last_scan: lastScanTime,
    signal_count: latestSignals.length,
    uptime: process.uptime()
  });
});

// 指标端点（Prometheus格式）
app.get('/api/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(metrics.toPrometheus());
});

// 获取风控配置
app.get('/api/config', (req, res) => {
  res.json({
    risk_management: {
      max_risk_per_trade: CONFIG.MAX_RISK_PER_TRADE,
      max_total_risk: CONFIG.MAX_TOTAL_RISK,
      default_leverage: CONFIG.DEFAULT_LEVERAGE,
      max_leverage: CONFIG.MAX_LEVERAGE,
      min_rrr: CONFIG.MIN_RRR,
      target_rrr: CONFIG.TARGET_RRR
    },
    signal_ttl_ms: CONFIG.SIGNAL_TTL_MS,
    data_thresholds: {
      healthy_ms: CONFIG.DATA_HEALTHY_THRESHOLD,
      stale_ms: CONFIG.DATA_STALE_THRESHOLD
    },
    score_weights: CONFIG.SCORE_WEIGHTS,
    penalties: CONFIG.PENALTIES,
    rate_limits: {
      scan_per_user: '10/hour',
      scan_global: '100/hour'
    }
  });
});

// ==================== V2.0 调试端点 ====================

// 获取币种环境调试信息
app.get('/api/debug/environment/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    InputValidator.validateSymbol(symbol);
    
    const klines = latestKlines[symbol];
    const ticker = latestTickers ? latestTickers[symbol] : null;
    
    if (!klines) {
      return res.status(404).json({ error: 'Symbol klines not found' });
    }
    
    // HTF Bias分析
    const htfBias = analyzeHTFBias(klines);
    
    // 确定方向
    const direction = htfBias.bias === 'NEUTRAL' ? 
      (htfBias.rsi > 50 ? 'LONG' : 'SHORT') : htfBias.bias;
    
    // 环境检查
    const envCheck = environmentCheckV2(klines, direction, ticker);
    
    // LTF确认
    const ltfConfirm = analyzeLTFConfirmation(klines, direction);
    
    res.json({
      symbol,
      timestamp: new Date().toISOString(),
      htf_bias: htfBias,
      environment_check: envCheck,
      ltf_confirmation: ltfConfirm,
      summary: {
        can_generate_tradable: envCheck.status !== 'FAIL' && ltfConfirm.canEnter,
        can_generate_candidate: envCheck.status !== 'FAIL',
        environment_status: envCheck.status,
        confirmation_score: ltfConfirm.confirmationScore
      }
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// 批量获取环境调试信息
app.get('/api/debug/environment', async (req, res) => {
  try {
    const { symbols, limit = 5 } = req.query;
    
    let targetSymbols;
    if (symbols) {
      targetSymbols = symbols.split(',').slice(0, 10);
    } else {
      // 返回最近被过滤的币种 + 随机样本
      const filteredSymbols = latestFiltered.slice(0, 3).map(f => f.symbol);
      const randomSymbols = SYMBOLS_54
        .filter(s => !filteredSymbols.includes(s))
        .sort(() => Math.random() - 0.5)
        .slice(0, limit - filteredSymbols.length);
      targetSymbols = [...filteredSymbols, ...randomSymbols];
    }
    
    const results = [];
    
    for (const symbol of targetSymbols) {
      const klines = latestKlines[symbol];
      const ticker = latestTickers ? latestTickers[symbol] : null;
      
      if (!klines) continue;
      
      const htfBias = analyzeHTFBias(klines);
      const direction = htfBias.bias === 'NEUTRAL' ? 
        (htfBias.rsi > 50 ? 'LONG' : 'SHORT') : htfBias.bias;
      const envCheck = environmentCheckV2(klines, direction, ticker);
      const ltfConfirm = analyzeLTFConfirmation(klines, direction);
      
      results.push({
        symbol,
        htf_bias: {
          bias: htfBias.bias,
          confidence: htfBias.confidence,
          rsi: htfBias.rsi,
          volatility: htfBias.volatility
        },
        environment: {
          status: envCheck.status,
          score: envCheck.environmentScore,
          grade: envCheck.environmentGrade,
          warnings: envCheck.warnings,
          failures: envCheck.failures
        },
        ltf_confirmation: {
          score: ltfConfirm.confirmationScore,
          grade: ltfConfirm.confirmationGrade,
          missing: ltfConfirm.missingConfirmations
        },
        signal_eligible: envCheck.status !== 'FAIL'
      });
    }
    
    res.json({
      count: results.length,
      symbols: targetSymbols,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// V2扫描（使用新策略）
app.post('/api/scan/v2', async (req, res) => {
  const userId = req.headers['x-user-id'] || 'anonymous';
  
  if (scanStatus.status === 'RUNNING') {
    return res.json({
      success: false,
      message: '扫描正在进行中',
      status: scanStatus
    });
  }
  
  try {
    scanRateLimiter.checkAndRecord(userId);
    
    updateScanStatus({
      status: 'RUNNING',
      progress: 0,
      processed: 0,
      total: SYMBOLS_54.length,
      startTime: new Date().toISOString(),
      message: '正在初始化V2扫描...'
    });
    
    logger.info('V2 Scan started', { userId, totalSymbols: SYMBOLS_54.length });
    
    // 获取K线数据
    updateScanStatus({ progress: 20, message: '正在获取K线数据...' });
    latestKlines = await withRetry(() => getAllKlines('4h', 100), { maxRetries: 3 });
    lastKlineUpdateTime = Date.now();
    
    // 获取实时价格
    updateScanStatus({ progress: 40, message: '正在获取实时价格...' });
    latestTickers = await withRetry(() => getTickers(), { maxRetries: 3 });
    
    // V2策略分析
    updateScanStatus({ progress: 50, message: '正在进行V2策略分析...' });
    
    const result = scanAllSymbolsV2(latestKlines, latestTickers, scanHistory);
    
    // 合并信号（tradable + candidate）
    latestSignals = [...result.tradable_signals, ...result.candidate_signals];
    latestFiltered = result.filtered;
    lastScanTime = new Date().toISOString();
    
    // 保存数据
    saveData();
    
    // 记录扫描日志
    recordScanLog({ 
      signals: result.tradable_signals, 
      filtered: result.filtered,
      scanType: 'V2'
    });
    
    updateScanStatus({
      status: 'IDLE',
      progress: 100,
      processed: SYMBOLS_54.length,
      endTime: new Date().toISOString(),
      message: `V2扫描完成，${result.tradable_signals.length}个可交易信号，${result.candidate_signals.length}个候选信号`
    });
    
    res.json({
      success: true,
      tradable_count: result.tradable_signals.length,
      candidate_count: result.candidate_signals.length,
      filtered_count: result.filtered.length,
      scan_type: 'V2',
      scan_time: lastScanTime,
      summary: result.summary
    });
    
  } catch (error) {
    logger.error('V2 Scan failed', { error: error.message });
    
    updateScanStatus({
      status: 'IDLE',
      progress: 0,
      endTime: new Date().toISOString(),
      message: `V2扫描失败: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR'
  });
});

// 启动服务器
app.listen(PORT, () => {
  logger.info('Server started', {
    port: PORT,
    env: process.env.NODE_ENV || 'development'
  });

  console.log(`Server running on port ${PORT}`);
  console.log(`API endpoints:`);
  console.log(`  GET  /api/signals      - Get current signals`);
  console.log(`  GET  /api/klines       - Get all klines data`);
  console.log(`  GET  /api/history      - Get scan history`);
  console.log(`  POST /api/scan         - Trigger manual scan`);
  console.log(`  POST /api/scan/v2      - Trigger V2 scan (with candidates)`);
  console.log(`  GET  /api/scan/status  - Get scan status`);
  console.log(`  GET  /api/scan/logs    - Get scan logs`);
  console.log(`  GET  /api/stats        - Get statistics`);
  console.log(`  GET  /api/health       - Health check`);
  console.log(`  GET  /api/metrics      - Prometheus metrics`);
  console.log(`  GET  /api/config       - Risk management config`);
  console.log(`  GET  /api/debug/environment/:symbol - Get environment debug for symbol`);
  console.log(`  GET  /api/debug/environment - Get batch environment debug`);

  loadHistory();
  performScan();
});

// ==================== 定时任务 ====================

// 1. 定时扫描 - 每15分钟自动刷新K线和价格数据
cron.schedule('*/15 * * * *', async () => {
  logger.info('Scheduled scan triggered (15min interval)');
  
  // 检查数据健康状态
  updateDataHealth();
  const health = getDataHealthInfo();
  
  if (health.status === 'DEAD') {
    logger.warn('Data is DEAD, forcing refresh before scan', { age_ms: health.age_ms });
    // 强制刷新K线和价格数据
    try {
      latestKlines = await withRetry(() => getAllKlines('4h', 100), { maxRetries: 3 });
      lastKlineUpdateTime = Date.now();
      latestTickers = await withRetry(() => getTickers(), { maxRetries: 3 });
      logger.info('Data refreshed successfully before scan');
    } catch (error) {
      logger.error('Failed to refresh data before scan', { error: error.message });
    }
  }
  
  performScan('scheduler');
});

// 2. 定时更新K线和价格数据 - 每5分钟（保持数据新鲜）
cron.schedule('*/5 * * * *', async () => {
  logger.info('Refreshing klines and tickers (5min interval)');
  try {
    const [klines, tickers] = await Promise.all([
      withRetry(() => getAllKlines('4h', 100), { maxRetries: 2 }),
      withRetry(() => getTickers(), { maxRetries: 2 })
    ]);
    
    latestKlines = klines;
    lastKlineUpdateTime = Date.now();
    latestTickers = tickers;
    
    logger.info('Klines and tickers refreshed', {
      klinesCount: Object.keys(klines).length,
      tickersCount: Object.keys(tickers).length
    });
  } catch (error) {
    logger.error('Failed to refresh klines and tickers', { error: error.message });
  }
});

// 3. 信号生命周期管理 - 每1分钟检查信号状态（对比实时价格判断是否触及止盈止损）
cron.schedule('* * * * *', async () => {
  await updateSignalStatusesWithRealtimePrices();
});

// 4. 数据健康监控 - 每1分钟检查，STALE/DEAD时告警
cron.schedule('* * * * *', () => {
  checkDataHealthAndAlert();
});

// 5. 定时清理幂等记录（每小时）
cron.schedule('0 * * * *', () => {
  scanIdempotency.cleanup();
  logger.info('Idempotency records cleaned up');
});

// ==================== 信号生命周期管理 ====================

// 使用实时价格更新信号状态
async function updateSignalStatusesWithRealtimePrices() {
  if (!latestSignals || latestSignals.length === 0) {
    return;
  }
  
  // 获取最新实时价格
  let currentPrices = {};
  try {
    currentPrices = await withRetry(() => getTickers(), { maxRetries: 2 });
  } catch (error) {
    logger.error('Failed to get realtime prices for signal status update', { error: error.message });
    return;
  }
  
  let updatedCount = 0;
  const now = Date.now();
  
  for (const signal of latestSignals) {
    // 只检查ACTIVE或PENDING状态的信号
    if (signal.status !== 'ACTIVE' && signal.status !== 'PENDING') {
      continue;
    }
    
    const symbol = signal.symbol;
    const ticker = currentPrices[symbol];
    
    if (!ticker || !ticker.last) {
      continue;
    }
    
    const currentPrice = parseFloat(ticker.last);
    const entryPrice = signal.entry_price;
    const sl = signal.sl;
    const tp1 = signal.tp1;
    const tp2 = signal.tp2;
    const direction = signal.direction;
    
    let newStatus = null;
    let statusReason = null;
    let pnl = 0;
    
    // 判断止盈止损
    if (direction === 'LONG') {
      // 做多：检查是否触及止损或止盈
      if (currentPrice <= sl) {
        newStatus = 'INVALIDATED';
        statusReason = 'STOP_LOSS_HIT';
        pnl = ((sl - entryPrice) / entryPrice * 100);
      } else if (currentPrice >= tp2) {
        newStatus = 'ENTERED';
        statusReason = 'TAKE_PROFIT_2_HIT';
        pnl = ((tp2 - entryPrice) / entryPrice * 100);
      } else if (currentPrice >= tp1) {
        newStatus = 'ENTERED';
        statusReason = 'TAKE_PROFIT_1_HIT';
        pnl = ((currentPrice - entryPrice) / entryPrice * 100);
      }
    } else {
      // 做空：检查是否触及止损或止盈
      if (currentPrice >= sl) {
        newStatus = 'INVALIDATED';
        statusReason = 'STOP_LOSS_HIT';
        pnl = ((entryPrice - sl) / entryPrice * 100);
      } else if (currentPrice <= tp2) {
        newStatus = 'ENTERED';
        statusReason = 'TAKE_PROFIT_2_HIT';
        pnl = ((entryPrice - tp2) / entryPrice * 100);
      } else if (currentPrice <= tp1) {
        newStatus = 'ENTERED';
        statusReason = 'TAKE_PROFIT_1_HIT';
        pnl = ((entryPrice - currentPrice) / entryPrice * 100);
      }
    }
    
    // 检查是否过期（4小时后）
    if (!newStatus && signal.timestamp) {
      const signalTime = new Date(signal.timestamp).getTime();
      const expiresAt = signalTime + 4 * 60 * 60 * 1000; // 4小时
      
      if (now > expiresAt) {
        newStatus = 'EXPIRED';
        statusReason = 'SIGNAL_EXPIRED';
        pnl = direction === 'LONG' 
          ? ((currentPrice - entryPrice) / entryPrice * 100)
          : ((entryPrice - currentPrice) / entryPrice * 100);
      }
    }
    
    // 更新信号状态
    if (newStatus) {
      const oldStatus = signal.status;
      signal.status = newStatus;
      signal.status_desc = getStatusDescription(newStatus, statusReason);
      signal.realized_pnl = pnl;
      signal.exit_price = currentPrice;
      signal.exit_time = new Date().toISOString();
      signal.exit_reason = statusReason;
      
      updatedCount++;
      
      logger.info('Signal status updated', {
        symbol,
        oldStatus,
        newStatus,
        reason: statusReason,
        pnl: pnl.toFixed(2) + '%',
        entryPrice,
        exitPrice: currentPrice
      });
    }
  }
  
  if (updatedCount > 0) {
    saveData();
    logger.info('Signal statuses updated', { updatedCount });
  }
}

// 获取状态描述
function getStatusDescription(status, reason) {
  const descriptions = {
    'ENTERED': { 'TAKE_PROFIT_1_HIT': '止盈1达成', 'TAKE_PROFIT_2_HIT': '止盈2达成' },
    'INVALIDATED': { 'STOP_LOSS_HIT': '止损触发' },
    'EXPIRED': { 'SIGNAL_EXPIRED': '信号过期' }
  };
  return descriptions[status]?.[reason] || status;
}

// ==================== 数据健康监控 ====================

// 数据健康状态告警
let lastAlertTime = 0;
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5分钟告警冷却

function checkDataHealthAndAlert() {
  updateDataHealth();
  const health = getDataHealthInfo();
  const now = Date.now();
  
  // STALE告警
  if (health.status === 'STALE') {
    if (now - lastAlertTime > ALERT_COOLDOWN) {
      logger.warn('DATA_HEALTH_ALERT: Data is STALE', {
        age_ms: health.age_ms,
        age_formatted: health.age_formatted,
        last_update: health.last_update,
        action: 'Attempting automatic refresh'
      });
      lastAlertTime = now;
      
      // 尝试自动刷新数据
      refreshDataSilently();
    }
  }
  
  // DEAD告警
  if (health.status === 'DEAD') {
    if (now - lastAlertTime > ALERT_COOLDOWN) {
      logger.error('DATA_HEALTH_ALERT: Data is DEAD', {
        age_ms: health.age_ms,
        age_formatted: health.age_formatted,
        last_update: health.last_update,
        action: 'Immediate refresh required'
      });
      lastAlertTime = now;
      
      // 强制刷新数据
      refreshDataSilently();
    }
  }
}

// 静默刷新数据（不触发扫描）
async function refreshDataSilently() {
  try {
    logger.info('Attempting silent data refresh');
    
    const [klines, tickers] = await Promise.all([
      withRetry(() => getAllKlines('4h', 100), { maxRetries: 2 }),
      withRetry(() => getTickers(), { maxRetries: 2 })
    ]);
    
    latestKlines = klines;
    lastKlineUpdateTime = Date.now();
    latestTickers = tickers;
    
    logger.info('Silent data refresh successful', {
      klinesCount: Object.keys(klines).length,
      tickersCount: Object.keys(tickers).length
    });
  } catch (error) {
    logger.error('Silent data refresh failed', { error: error.message });
  }
}

module.exports = { app, performScan };
