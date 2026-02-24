/**
 * SMC/ICT 策略分析模块
 * 包含ChoCH、FVG、Sweep、Order Block等核心检测功能
 */

// 策略配置
const CONFIG = {
  // 摆动点检测
  SWING_LOOKBACK: 5,
  SWING_THRESHOLD: 0.3,
  
  // FVG检测
  FVG_MIN_SIZE_PERCENT: 0.1,
  
  // Sweep检测
  SWEP_WICK_RATIO: 2.0,
  SWEP_RECLAIM_RATIO: 0.5,
  
  // 趋势判断
  TREND_MA_PERIOD: 20,
  TREND_ATR_PERIOD: 14,
  
  // 信号评分
  SCORE_THRESHOLDS: {
    S: 85,
    A: 70,
    B: 55,
    C: 40
  },
  
  // 风控参数
  MIN_RRR: 2.0,
  MAX_RRR: 5.0,
  MAX_RISK_PER_TRADE: 0.01,
  DEFAULT_LEVERAGE: 3,
  
  // 信号有效期
  SIGNAL_TTL_HOURS: 4,
  
  // 频率限制
  MIN_SIGNAL_INTERVAL_HOURS: 4
};

/**
 * 计算ATR (Average True Range)
 * @param {Array} klines - K线数据
 * @param {number} period - 周期
 * @returns {number} ATR值
 */
function calculateATR(klines, period = 14) {
  if (klines.length < period + 1) return 0;
  
  const trValues = [];
  for (let i = 1; i < klines.length; i++) {
    const current = klines[i];
    const prev = klines[i - 1];
    
    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - prev.close);
    const tr3 = Math.abs(current.low - prev.close);
    
    trValues.push(Math.max(tr1, tr2, tr3));
  }
  
  // 使用简单移动平均计算ATR
  const recentTR = trValues.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

/**
 * 计算RSI
 * @param {Array} klines - K线数据
 * @param {number} period - 周期
 * @returns {number} RSI值
 */
function calculateRSI(klines, period = 14) {
  if (klines.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = klines.length - period; i < klines.length; i++) {
    const change = klines[i].close - klines[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * 寻找摆动高低点
 * @param {Array} klines - K线数据
 * @param {number} lookback - 回望周期
 * @returns {Object} 摆动高低点数组
 */
function findSwingPoints(klines, lookback = 5) {
  const swingHighs = [];
  const swingLows = [];
  
  for (let i = lookback; i < klines.length - lookback; i++) {
    const current = klines[i];
    
    // 检查摆动高点
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (klines[i - j].high >= current.high || klines[i + j].high >= current.high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      swingHighs.push({ index: i, price: current.high, timestamp: current.timestamp });
    }
    
    // 检查摆动低点
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (klines[i - j].low <= current.low || klines[i + j].low <= current.low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      swingLows.push({ index: i, price: current.low, timestamp: current.timestamp });
    }
  }
  
  return { swingHighs, swingLows };
}

/**
 * 检测结构转变 (Change of Character, ChoCH)
 * @param {Array} klines - K线数据
 * @param {Array} swingHighs - 摆动高点
 * @param {Array} swingLows - 摆动低点
 * @returns {Object|null} ChoCH检测结果
 */
function detectChoCH(klines, swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  
  const recentHighs = swingHighs.slice(-3);
  const recentLows = swingLows.slice(-3);
  
  // 看涨ChoCH: 低点抬高
  if (recentLows.length >= 2) {
    const lastLow = recentLows[recentLows.length - 1];
    const prevLow = recentLows[recentLows.length - 2];
    
    if (lastLow.price > prevLow.price) {
      return {
        type: 'BULLISH_CHOCH',
        level: lastLow.price,
        strength: (lastLow.price - prevLow.price) / prevLow.price,
        timestamp: lastLow.timestamp
      };
    }
  }
  
  // 看跌ChoCH: 高点降低
  if (recentHighs.length >= 2) {
    const lastHigh = recentHighs[recentHighs.length - 1];
    const prevHigh = recentHighs[recentHighs.length - 2];
    
    if (lastHigh.price < prevHigh.price) {
      return {
        type: 'BEARISH_CHOCH',
        level: lastHigh.price,
        strength: (prevHigh.price - lastHigh.price) / prevHigh.price,
        timestamp: lastHigh.timestamp
      };
    }
  }
  
  return null;
}

/**
 * 检测FVG (Fair Value Gap)
 * @param {Array} klines - K线数据
 * @returns {Array} FVG列表
 */
function detectFVG(klines) {
  const fvgList = [];
  
  for (let i = 2; i < klines.length; i++) {
    const k1 = klines[i - 2];
    const k2 = klines[i - 1];
    const k3 = klines[i];
    
    // 看涨FVG: k1高点 < k3低点
    if (k1.high < k3.low) {
      const size = k3.low - k1.high;
      const midPrice = (k1.high + k3.low) / 2;
      const sizePercent = (size / midPrice) * 100;
      
      if (sizePercent >= CONFIG.FVG_MIN_SIZE_PERCENT) {
        fvgList.push({
          type: 'BULLISH_FVG',
          top: k3.low,
          bottom: k1.high,
          size: size,
          sizePercent: sizePercent,
          timestamp: k3.timestamp,
          index: i
        });
      }
    }
    
    // 看跌FVG: k1低点 > k3高点
    if (k1.low > k3.high) {
      const size = k1.low - k3.high;
      const midPrice = (k1.low + k3.high) / 2;
      const sizePercent = (size / midPrice) * 100;
      
      if (sizePercent >= CONFIG.FVG_MIN_SIZE_PERCENT) {
        fvgList.push({
          type: 'BEARISH_FVG',
          top: k1.low,
          bottom: k3.high,
          size: size,
          sizePercent: sizePercent,
          timestamp: k3.timestamp,
          index: i
        });
      }
    }
  }
  
  return fvgList;
}

/**
 * 检测流动性扫荡 (Liquidity Sweep)
 * @param {Array} klines - K线数据
 * @returns {Object|null} Sweep检测结果
 */
function detectSweep(klines) {
  if (klines.length < 10) return null;
  
  const { swingHighs, swingLows } = findSwingPoints(klines, 3);
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  
  const recentKlines = klines.slice(-5);
  const lastKline = klines[klines.length - 1];
  
  // 获取关键高低点作为流动性池
  const recentSwingHigh = swingHighs[swingHighs.length - 1];
  const recentSwingLow = swingLows[swingLows.length - 1];
  
  // 检测向上扫荡 (做空场景)
  for (const k of recentKlines) {
    const wickAbove = k.high - Math.max(k.open, k.close);
    const bodySize = Math.abs(k.close - k.open);
    
    if (k.high > recentSwingHigh.price && 
        wickAbove > bodySize * CONFIG.SWEP_WICK_RATIO &&
        k.close < recentSwingHigh.price) {
      return {
        type: 'HIGH_SWEEP',
        direction: 'BEARISH',
        sweptLevel: recentSwingHigh.price,
        wickHigh: k.high,
        reclaimLevel: k.close,
        timestamp: k.timestamp,
        evidence: 'Wick swept high, closed back below'
      };
    }
  }
  
  // 检测向下扫荡 (做多场景)
  for (const k of recentKlines) {
    const wickBelow = Math.min(k.open, k.close) - k.low;
    const bodySize = Math.abs(k.close - k.open);
    
    if (k.low < recentSwingLow.price && 
        wickBelow > bodySize * CONFIG.SWEP_WICK_RATIO &&
        k.close > recentSwingLow.price) {
      return {
        type: 'LOW_SWEEP',
        direction: 'BULLISH',
        sweptLevel: recentSwingLow.price,
        wickLow: k.low,
        reclaimLevel: k.close,
        timestamp: k.timestamp,
        evidence: 'Wick swept low, closed back above'
      };
    }
  }
  
  return null;
}

/**
 * 检测订单块 (Order Block)
 * @param {Array} klines - K线数据
 * @returns {Array} 订单块列表
 */
function detectOrderBlocks(klines) {
  const obs = [];
  
  for (let i = 3; i < klines.length - 1; i++) {
    const k0 = klines[i - 1]; // 推动K线前的K线
    const k1 = klines[i];     // 推动K线
    const k2 = klines[i + 1]; // 后续K线
    
    // 看涨订单块: 下跌后强势上涨
    if (k0.close < k0.open && // 前一根下跌
        k1.close > k1.open && // 当前上涨
        k1.close > k0.high && // 突破前高
        k2.close > k2.open) { // 后续继续上涨
      obs.push({
        type: 'BULLISH_OB',
        high: k1.high,
        low: k1.low,
        timestamp: k1.timestamp,
        index: i,
        strength: (k1.close - k1.open) / k1.open
      });
    }
    
    // 看跌订单块: 上涨后强势下跌
    if (k0.close > k0.open && // 前一根上涨
        k1.close < k1.open && // 当前下跌
        k1.close < k0.low &&  // 突破前低
        k2.close < k2.open) { // 后续继续下跌
      obs.push({
        type: 'BEARISH_OB',
        high: k1.high,
        low: k1.low,
        timestamp: k1.timestamp,
        index: i,
        strength: (k1.open - k1.close) / k1.open
      });
    }
  }
  
  return obs;
}

/**
 * 详细趋势判断
 * @param {Array} klines - K线数据
 * @returns {Object} 趋势分析结果
 */
function determineTrendDetailed(klines) {
  if (klines.length < CONFIG.TREND_MA_PERIOD) {
    return { direction: 'NEUTRAL', strength: 0, confidence: 'low' };
  }
  
  // 计算移动平均线
  const recentKlines = klines.slice(-CONFIG.TREND_MA_PERIOD);
  const sma = recentKlines.reduce((sum, k) => sum + k.close, 0) / CONFIG.TREND_MA_PERIOD;
  
  const currentPrice = klines[klines.length - 1].close;
  const priceChange = (currentPrice - sma) / sma;
  
  // 计算趋势强度
  let direction = 'NEUTRAL';
  let strength = Math.abs(priceChange);
  
  if (priceChange > 0.02) direction = 'BULLISH';
  else if (priceChange > 0.005) direction = 'WEAK_BULLISH';
  else if (priceChange < -0.02) direction = 'BEARISH';
  else if (priceChange < -0.005) direction = 'WEAK_BEARISH';
  
  // 使用RSI确认
  const rsi = calculateRSI(klines, 14);
  let confidence = 'medium';
  
  if ((direction === 'BULLISH' && rsi > 50) || 
      (direction === 'BEARISH' && rsi < 50)) {
    confidence = 'high';
  } else if ((direction === 'BULLISH' && rsi < 40) || 
             (direction === 'BEARISH' && rsi > 60)) {
    confidence = 'low';
  }
  
  return { direction, strength, confidence, rsi, sma };
}

/**
 * 频率过滤器
 * @param {string} symbol - 交易对
 * @param {Array} recentSignals - 近期信号
 * @returns {Object} 过滤结果
 */
function frequencyFilter(symbol, recentSignals) {
  const now = Date.now();
  const cutoff = now - CONFIG.MIN_SIGNAL_INTERVAL_HOURS * 3600 * 1000;
  
  const recentSymbolSignals = recentSignals.filter(s => 
    s.symbol === symbol && new Date(s.timestamp).getTime() > cutoff
  );
  
  if (recentSymbolSignals.length > 0) {
    return {
      passed: false,
      reason: 'FREQUENCY_LIMIT',
      detail: `Last signal ${recentSymbolSignals[0].timestamp}`,
      nextAllowed: new Date(cutoff + CONFIG.MIN_SIGNAL_INTERVAL_HOURS * 3600 * 1000).toISOString()
    };
  }
  
  return { passed: true };
}

/**
 * 环境过滤器
 * @param {Array} klines - K线数据
 * @param {string} direction - 交易方向
 * @param {Object} ticker - 实时价格数据
 * @returns {Object} 过滤结果
 */
function environmentFilter(klines, direction, ticker) {
  const checks = [];
  
  // 检查成交量
  const volumeCheck = {
    name: 'volume',
    passed: ticker && ticker.volume24h > 500000,
    detail: ticker ? `24h volume: ${ticker.volume24h}` : 'No ticker data'
  };
  checks.push(volumeCheck);
  
  // 检查波动率
  const atr = calculateATR(klines, 14);
  const avgPrice = klines.slice(-14).reduce((s, k) => s + k.close, 0) / 14;
  const volatility = (atr / avgPrice) * 100;
  const volatilityCheck = {
    name: 'volatility',
    passed: volatility > 0.5 && volatility < 10,
    detail: `ATR: ${atr.toFixed(4)}, Volatility: ${volatility.toFixed(2)}%`
  };
  checks.push(volatilityCheck);
  
  // 检查趋势一致性
  const trend = determineTrendDetailed(klines);
  const trendCheck = {
    name: 'trend_alignment',
    passed: (direction === 'LONG' && trend.direction.includes('BULLISH')) ||
            (direction === 'SHORT' && trend.direction.includes('BEARISH')) ||
            trend.direction === 'NEUTRAL',
    detail: `Trend: ${trend.direction}, Confidence: ${trend.confidence}`
  };
  checks.push(trendCheck);
  
  const passed = checks.every(c => c.passed);
  
  return { passed, checks };
}

/**
 * 降级过滤器
 * @param {Object} signal - 信号对象
 * @param {Array} klines - K线数据
 * @param {Object} ticker - 实时价格数据
 * @returns {Object} 降级结果
 */
function degradationFilter(signal, klines, ticker) {
  let adjustedScore = signal.baseScore || 70;
  const penalties = [];
  
  // 成交量惩罚
  if (ticker && ticker.volume24h < 400000) {
    const penalty = 10;
    adjustedScore -= penalty;
    penalties.push({ reason: 'LOW_VOLUME', penalty, detail: `Volume: ${ticker.volume24h}` });
  }
  
  // ChoCH强度惩罚
  if (signal.choch && !signal.choch.isStrong) {
    const penalty = 5;
    adjustedScore -= penalty;
    penalties.push({ reason: 'WEAK_CHOCH', penalty });
  }
  
  // 距离惩罚（入场价离当前价太远）
  const currentPrice = klines[klines.length - 1].close;
  const distance = Math.abs(signal.entry_price - currentPrice) / currentPrice;
  if (distance > 0.05) {
    const penalty = Math.min(15, distance * 100);
    adjustedScore -= penalty;
    penalties.push({ reason: 'FAR_ENTRY', penalty: Math.round(penalty), detail: `Distance: ${(distance * 100).toFixed(2)}%` });
  }
  
  return {
    originalScore: signal.baseScore || 70,
    adjustedScore: Math.max(0, adjustedScore),
    penalties,
    ratingThresholds: CONFIG.SCORE_THRESHOLDS
  };
}

/**
 * 风控检查
 * @param {Object} signal - 信号对象
 * @param {number} accountBalance - 账户余额
 * @returns {Object} 风控结果
 */
function riskManagementCheck(signal, accountBalance = 10000) {
  const checks = [];
  
  // RRR检查
  const rrrCheck = {
    name: 'rrr_minimum',
    passed: signal.rrr >= CONFIG.MIN_RRR,
    value: signal.rrr,
    threshold: CONFIG.MIN_RRR,
    detail: `RRR: ${signal.rrr.toFixed(2)} (min: ${CONFIG.MIN_RRR})`
  };
  checks.push(rrrCheck);
  
  // 止损距离检查
  const slDistance = Math.abs(signal.entry_price - signal.sl) / signal.entry_price;
  const slCheck = {
    name: 'sl_distance',
    passed: slDistance > 0.005 && slDistance < 0.1,
    value: slDistance,
    detail: `SL distance: ${(slDistance * 100).toFixed(2)}%`
  };
  checks.push(slCheck);
  
  // 计算仓位
  const riskAmount = accountBalance * CONFIG.MAX_RISK_PER_TRADE;
  const slPercent = slDistance;
  const positionSize = riskAmount / (signal.entry_price * slPercent);
  const leverage = Math.min(CONFIG.DEFAULT_LEVERAGE, Math.floor(1 / slPercent));
  
  const allPassed = checks.every(c => c.passed);
  
  return {
    executionStatus: allPassed ? 'PASS' : 'BLOCK',
    checks,
    positionSize: Math.floor(positionSize),
    leverage,
    riskAmount,
    calculationBasis: {
      accountBalance,
      maxRiskPercent: CONFIG.MAX_RISK_PER_TRADE,
      defaultLeverage: CONFIG.DEFAULT_LEVERAGE,
      contractType: 'USDT-M'
    }
  };
}

/**
 * 扫描所有交易对（单层分析 - 保持向后兼容）
 * @param {Object} klinesData - K线数据对象
 * @param {Object} tickersData - 实时价格数据
 * @param {Array} scanHistory - 扫描历史
 * @returns {Object} 扫描结果
 */
function scanAllSymbols(klinesData, tickersData, scanHistory = []) {
  const signals = [];
  const filtered = [];
  
  for (const [symbol, klines] of Object.entries(klinesData)) {
    try {
      const ticker = tickersData ? tickersData[symbol] : null;
      
      // 频率过滤
      const freqResult = frequencyFilter(symbol, scanHistory);
      if (!freqResult.passed) {
        filtered.push({ symbol, reason: freqResult.reason, detail: freqResult.detail });
        continue;
      }
      
      // 分析
      const { swingHighs, swingLows } = findSwingPoints(klines);
      const choch = detectChoCH(klines, swingHighs, swingLows);
      const fvgList = detectFVG(klines);
      const sweep = detectSweep(klines);
      const obs = detectOrderBlocks(klines);
      const trend = determineTrendDetailed(klines);
      
      // 生成信号条件
      let signal = null;
      
      if (choch && fvgList.length > 0) {
        const direction = choch.type === 'BULLISH_CHOCH' ? 'LONG' : 'SHORT';
        const relevantFVG = fvgList[fvgList.length - 1];
        
        // 环境过滤
        const envResult = environmentFilter(klines, direction, ticker);
        if (!envResult.passed) {
          filtered.push({ symbol, reason: 'ENVIRONMENT_NOT_SUITABLE', checks: envResult.checks });
          continue;
        }
        
        // 计算入场/止损/止盈
        const entryPrice = klines[klines.length - 1].close;
        const atr = calculateATR(klines, 14);
        
        let sl, tp1, tp2;
        if (direction === 'LONG') {
          sl = Math.min(relevantFVG.bottom, swingLows[swingLows.length - 1]?.price || entryPrice * 0.95);
          tp1 = entryPrice + (entryPrice - sl) * 2;
          tp2 = entryPrice + (entryPrice - sl) * 3;
        } else {
          sl = Math.max(relevantFVG.top, swingHighs[swingHighs.length - 1]?.price || entryPrice * 1.05);
          tp1 = entryPrice - (sl - entryPrice) * 2;
          tp2 = entryPrice - (sl - entryPrice) * 3;
        }
        
        const rrr = Math.abs(tp1 - entryPrice) / Math.abs(entryPrice - sl);
        
        // 基础评分
        let baseScore = 70;
        if (sweep) baseScore += 10;
        if (obs.length > 0) baseScore += 5;
        if (trend.confidence === 'high') baseScore += 10;
        
        // 降级过滤
        const degradation = degradationFilter(
          { baseScore, entry_price: entryPrice, choch },
          klines,
          ticker
        );
        
        // 风控检查
        const riskCheck = riskManagementCheck({ entry_price: entryPrice, sl, rrr });
        
        if (riskCheck.executionStatus === 'BLOCK') {
          filtered.push({ symbol, reason: 'RISK_CHECK_FAILED', checks: riskCheck.checks });
          continue;
        }
        
        // 确定评级
        let rating = 'C';
        if (degradation.adjustedScore >= CONFIG.SCORE_THRESHOLDS.S) rating = 'S';
        else if (degradation.adjustedScore >= CONFIG.SCORE_THRESHOLDS.A) rating = 'A';
        else if (degradation.adjustedScore >= CONFIG.SCORE_THRESHOLDS.B) rating = 'B';
        
        signal = {
          id: `${symbol}_${Date.now()}`,
          symbol,
          direction,
          entry_price: entryPrice,
          sl,
          tp1,
          tp2,
          rrr,
          rating,
          score: degradation.adjustedScore,
          choch,
          fvg: relevantFVG,
          sweep,
          order_blocks: obs.slice(-2),
          trend,
          risk_management: riskCheck,
          timestamp: new Date().toISOString(),
          timeframe: '4h'
        };
        
        signals.push(signal);
      }
    } catch (error) {
      console.error(`Error analyzing ${symbol}:`, error.message);
    }
  }
  
  return { signals, filtered };
}

module.exports = {
  CONFIG,
  calculateATR,
  calculateRSI,
  findSwingPoints,
  detectChoCH,
  detectFVG,
  detectSweep,
  detectOrderBlocks,
  determineTrendDetailed,
  frequencyFilter,
  environmentFilter,
  degradationFilter,
  riskManagementCheck,
  scanAllSymbols
};
