/**
 * MTF扫描器 - 多时间框架信号扫描
 * 
 * 整合P0核心功能:
 * 1. MTF三层对齐 (4H-15M-1M)
 * 2. 流动性扫荡前置
 * 3. 高二/低二入场确认
 */

const {
  analyzeMultiTimeframe,
  checkAlignmentGate,
  detectHiLoTwo
} = require('./multiTimeframe');

const {
  requireLiquiditySweep,
  waitForSweepWorkflow
} = require('./liquiditySweep');

const {
  calculateATR,
  calculateRSI,
  frequencyFilter,
  environmentFilter,
  degradationFilter,
  riskManagementCheck,
  CONFIG: STRATEGY_CONFIG
} = require('./strategy');

// MTF扫描器配置
const MTF_SCANNER_CONFIG = {
  // 时间框架
  TIMEFRAMES: ['4h', '15m', '1m'],
  
  // 对齐门控
  ALIGNMENT_GATE: {
    enabled: true,
    strictMode: true
  },
  
  // 流动性扫荡
  SWEEP_REQUIRED: true,
  
  // 高二/低二
  HILO_REQUIRED: true,
  
  // 最小RRR
  MIN_RRR: 2.0,
  
  // 评分阈值
  SCORE_THRESHOLDS: {
    S: 85,
    A: 70,
    B: 55,
    C: 40
  }
};

/**
 * 扫描单个交易对（MTF完整流程）
 * @param {string} symbol - 交易对
 * @param {Object} mtfData - 多时间框架数据
 * @param {Object} ticker - 实时价格数据
 * @param {Array} scanHistory - 扫描历史
 * @returns {Object} 扫描结果
 */
async function scanSymbolMTF(symbol, mtfData, ticker, scanHistory = []) {
  const result = {
    symbol,
    timestamp: new Date().toISOString(),
    signal: null,
    blocked: false,
    blockReason: null,
    analysis: {},
    evidenceChain: []
  };
  
  try {
    // ========== 步骤1: 频率过滤 ==========
    const freqResult = frequencyFilter(symbol, scanHistory);
    if (!freqResult.passed) {
      result.blocked = true;
      result.blockReason = freqResult.reason;
      result.blockDetail = freqResult.detail;
      return result;
    }
    
    // ========== 步骤2: MTF分析 ==========
    const mtfAnalysis = analyzeMultiTimeframe(mtfData);
    result.analysis.mtf = mtfAnalysis;
    
    // 记录证据
    result.evidenceChain.push({
      step: 'MTF_ANALYSIS',
      htfDirection: mtfAnalysis.htf.direction,
      mtfDirection: mtfAnalysis.mtf.direction,
      ltfDirection: mtfAnalysis.ltf.direction,
      aligned: mtfAnalysis.aligned,
      gatePassed: mtfAnalysis.gate.passed
    });
    
    // 对齐门控检查
    if (!mtfAnalysis.canGenerateSignal) {
      result.blocked = true;
      result.blockReason = mtfAnalysis.blockedReason;
      result.alignmentDetails = mtfAnalysis.gate.details;
      return result;
    }
    
    // ========== 步骤3: 流动性扫荡前置 ==========
    const sweepResult = requireLiquiditySweep(
      mtfData['15m'],  // 在15M级别检测扫荡
      mtfAnalysis.htf.direction,
      { CONFIRMATION_REQUIRED: MTF_SCANNER_CONFIG.SWEEP_REQUIRED }
    );
    result.analysis.sweep = sweepResult;
    
    result.evidenceChain.push({
      step: 'LIQUIDITY_SWEEP',
      passed: sweepResult.passed,
      required: sweepResult.required,
      sweepType: sweepResult.check.sweepDetails?.type,
      confirmation: sweepResult.check.sweepDetails?.confirmation?.confirmed
    });
    
    if (!sweepResult.passed && sweepResult.required) {
      result.blocked = true;
      result.blockReason = 'LIQUIDITY_SWEEP_REQUIRED';
      result.missingConfirmation = 'LIQUIDITY_SWEEP';
      return result;
    }
    
    // ========== 步骤4: 高二/低二入场确认 ==========
    const hiloResult = detectHiLoTwo(
      mtfData['1m'],  // 在1M级别做高二/低二计数
      mtfAnalysis.htf.direction
    );
    result.analysis.hilo = hiloResult;
    
    result.evidenceChain.push({
      step: 'HILO_COUNT',
      valid: hiloResult.valid,
      type: hiloResult.type,
      countingPaused: hiloResult.countingPaused,
      pauseReason: hiloResult.pauseReason
    });
    
    if (MTF_SCANNER_CONFIG.HILO_REQUIRED && !hiloResult.valid) {
      result.blocked = true;
      result.blockReason = 'HILO_CONFIRMATION_REQUIRED';
      result.hiloStatus = hiloResult.type;  // 'HIGH_ONE' | 'LOW_ONE' | 'NONE'
      return result;
    }
    
    // ========== 步骤5: 生成信号 ==========
    const signal = generateMTFSignal(symbol, mtfAnalysis, sweepResult, hiloResult, ticker, mtfData);
    
    // ========== 步骤6: 风控检查 ==========
    const riskCheck = riskManagementCheck(signal, 10000);
    result.analysis.risk = riskCheck;
    
    if (riskCheck.executionStatus === 'BLOCK') {
      result.blocked = true;
      result.blockReason = 'RISK_CHECK_FAILED';
      result.riskChecks = riskCheck.checks;
      return result;
    }
    
    signal.risk_management = riskCheck;
    result.signal = signal;
    
  } catch (error) {
    result.blocked = true;
    result.blockReason = 'ANALYSIS_ERROR';
    result.error = error.message;
  }
  
  return result;
}

/**
 * 生成MTF信号
 * @param {string} symbol - 交易对
 * @param {Object} mtfAnalysis - MTF分析结果
 * @param {Object} sweepResult - 扫荡结果
 * @param {Object} hiloResult - 高二/低二结果
 * @param {Object} ticker - 实时价格数据
 * @param {Object} mtfData - 原始K线数据
 * @returns {Object} 信号对象
 */
function generateMTFSignal(symbol, mtfAnalysis, sweepResult, hiloResult, ticker, mtfData) {
  const direction = mtfAnalysis.htf.direction;
  const htf = mtfAnalysis.htf;
  const mtf = mtfAnalysis.mtf;
  const ltf = mtfAnalysis.ltf;
  
  // 获取入场价格
  let entryPrice;
  if (hiloResult.valid && hiloResult.entryPrice) {
    entryPrice = hiloResult.entryPrice;
  } else {
    entryPrice = mtfData['1m'][mtfData['1m'].length - 1].close;
  }
  
  // 获取止损价格
  let stopLoss;
  if (hiloResult.valid && hiloResult.stopLoss) {
    stopLoss = hiloResult.stopLoss;
  } else if (mtf.fvg && mtf.fvg.length > 0) {
    const fvg = mtf.fvg[mtf.fvg.length - 1];
    stopLoss = direction === 'LONG' ? fvg.bottom : fvg.top;
  } else {
    const atr = calculateATR(mtfData['15m'], 14);
    stopLoss = direction === 'LONG' 
      ? entryPrice - atr * 1.5 
      : entryPrice + atr * 1.5;
  }
  
  // 计算止盈
  const risk = Math.abs(entryPrice - stopLoss);
  const tp1 = direction === 'LONG' ? entryPrice + risk * 2 : entryPrice - risk * 2;
  const tp2 = direction === 'LONG' ? entryPrice + risk * 3 : entryPrice - risk * 3;
  
  // 计算RRR
  const rrr = Math.abs(tp1 - entryPrice) / risk;
  
  // 基础评分
  let baseScore = 70;
  
  // MTF对齐加分
  if (mtfAnalysis.aligned) baseScore += 10;
  
  // 扫荡确认加分
  if (sweepResult.passed) baseScore += 10;
  
  // 高二/低二加分
  if (hiloResult.valid) baseScore += 10;
  
  // 强力BOS加分
  if (mtf.strongCloseConfirmed) baseScore += 5;
  
  // 趋势置信度加分
  if (htf.trend.confidence === 'high') baseScore += 5;
  
  // 降级过滤
  const degradation = degradationFilter(
    { baseScore, entry_price: entryPrice, choch: mtf.choch },
    mtfData['15m'],
    ticker
  );
  
  // 确定评级
  let rating = 'C';
  if (degradation.adjustedScore >= MTF_SCANNER_CONFIG.SCORE_THRESHOLDS.S) rating = 'S';
  else if (degradation.adjustedScore >= MTF_SCANNER_CONFIG.SCORE_THRESHOLDS.A) rating = 'A';
  else if (degradation.adjustedScore >= MTF_SCANNER_CONFIG.SCORE_THRESHOLDS.B) rating = 'B';
  
  // 计算过期时间（4小时后）
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  
  // 构建信号对象
  const signal = {
    id: `${symbol}_${Date.now()}`,
    symbol,
    direction,
    entry_price: entryPrice,
    sl: stopLoss,
    tp1,
    tp2,
    rrr,
    rating,
    score: degradation.adjustedScore,
    
    // 状态字段（前端必需）
    status: 'ACTIVE',
    status_reason: null,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    triggered_at: null,
    closed_at: null,
    
    // MTF信息
    mtf: {
      htf: {
        direction: htf.direction,
        trend: htf.trend,
        poi: htf.poi.slice(0, 3)  // 前3个关键区域
      },
      mtf: {
        direction: mtf.direction,
        choch: mtf.choch,
        bos: mtf.bos,
        strongCloseConfirmed: mtf.strongCloseConfirmed,
        inHTFPOI: mtf.inHTFPOI
      },
      ltf: {
        direction: ltf.direction,
        sweep: ltf.sweep,
        internalBOS: ltf.internalBOS,
        hiloCount: hiloResult,
        inEntryZone: ltf.inEntryZone
      },
      aligned: mtfAnalysis.aligned
    },
    
    // 流动性扫荡
    liquidity_sweep: sweepResult.passed ? {
      detected: true,
      type: sweepResult.check.sweepDetails.type,
      pool: sweepResult.check.sweepDetails.pool,
      metrics: sweepResult.check.sweepDetails.metrics,
      confirmation: sweepResult.check.sweepDetails.confirmation
    } : null,
    
    // 入场确认
    entry_confirmation: hiloResult.valid ? {
      type: hiloResult.type,
      entryPrice: hiloResult.entryPrice,
      stopLoss: hiloResult.stopLoss
    } : null,
    
    // 时间戳
    timestamp: new Date().toISOString(),
    timeframe: 'MTF_4H_15M_1M',
    
    // 数据健康
    data_health: {
      htf_candles: mtfData['4h'].length,
      mtf_candles: mtfData['15m'].length,
      ltf_candles: mtfData['1m'].length,
      status: 'HEALTHY'
    }
  };
  
  return signal;
}

/**
 * 批量扫描所有交易对（MTF）
 * @param {Object} allMtfData - 所有交易对的多时间框架数据
 * @param {Object} tickersData - 实时价格数据
 * @param {Array} scanHistory - 扫描历史
 * @returns {Object} 扫描结果
 */
async function scanAllSymbolsMTF(allMtfData, tickersData, scanHistory = []) {
  const signals = [];
  const filtered = [];
  const errors = [];
  
  for (const [symbol, mtfData] of Object.entries(allMtfData)) {
    try {
      const ticker = tickersData ? tickersData[symbol] : null;
      
      const result = await scanSymbolMTF(symbol, mtfData, ticker, scanHistory);
      
      if (result.signal) {
        signals.push(result.signal);
      } else if (result.blocked) {
        filtered.push({
          symbol,
          reason: result.blockReason,
          detail: result.blockDetail || result.missingConfirmation,
          evidenceChain: result.evidenceChain
        });
      }
    } catch (error) {
      errors.push({ symbol, error: error.message });
    }
  }
  
  return {
    signals,
    filtered,
    errors,
    summary: {
      total: Object.keys(allMtfData).length,
      signals: signals.length,
      filtered: filtered.length,
      errors: errors.length
    }
  };
}

/**
 * 获取信号解释（用于前端展示）
 * @param {Object} signal - 信号对象
 * @returns {Object} 解释文本
 */
function explainSignal(signal) {
  const explanations = {
    direction: signal.direction === 'LONG' ? '做多' : '做空',
    
    mtf_alignment: signal.mtf.aligned 
      ? '三层时间框架方向一致' 
      : '时间框架方向存在分歧',
    
    htf_analysis: `${signal.mtf.htf.direction === 'LONG' ? '看涨' : '看跌'}趋势，关键区域: ${
      signal.mtf.htf.poi.map(p => p.type).join(', ')
    }`,
    
    mtf_confirmation: signal.mtf.mtf.choch 
      ? `检测到${signal.mtf.mtf.choch.type}，${signal.mtf.mtf.strongCloseConfirmed ? '已强力收盘确认' : '普通确认'}`
      : '未检测到结构转变',
    
    ltf_trigger: signal.mtf.ltf.hiloCount?.valid
      ? `${signal.mtf.ltf.hiloCount.type}确认，精确入场点`
      : '等待高二/低二确认',
    
    liquidity_sweep: signal.liquidity_sweep
      ? `已扫荡${signal.liquidity_sweep.type === 'SELL_SIDE_SWEEP' ? '卖方' : '买方'}流动性`
      : '未检测到流动性扫荡',
    
    entry_logic: `入场价: ${signal.entry_price.toFixed(4)}, 止损: ${signal.sl.toFixed(4)}, 止盈1: ${signal.tp1.toFixed(4)} (RRR: ${signal.rrr.toFixed(2)})`,
    
    risk_note: `建议仓位: ${signal.risk_management?.positionSize || 'N/A'}, 杠杆: ${signal.risk_management?.leverage || 'N/A'}x`
  };
  
  return explanations;
}

module.exports = {
  MTF_SCANNER_CONFIG,
  scanSymbolMTF,
  scanAllSymbolsMTF,
  generateMTFSignal,
  explainSignal
};
