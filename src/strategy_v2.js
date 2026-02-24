/**
 * SMC/ICT 策略分析模块 V2.0
 * 
 * 核心改进：
 * 1. 环境检查三态化：PASS / WARN / FAIL
 * 2. HTF Bias Gate + LTF Entry Confirmation 两段式架构
 * 3. 可解释的子原因输出
 * 4. 候选信号（candidate）机制
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
  MIN_SIGNAL_INTERVAL_HOURS: 4,
  
  // 数据健康阈值
  DATA_HEALTHY_THRESHOLD: 5 * 60 * 1000,  // 5分钟
  DATA_STALE_THRESHOLD: 15 * 60 * 1000,   // 15分钟
  
  // 环境检查阈值
  ENVIRONMENT: {
    // 波动率阈值
    MIN_VOLATILITY: 0.3,   // 从0.5降低到0.3
    MAX_VOLATILITY: 15,    // 从10提高到15
    
    // 成交量阈值
    MIN_VOLUME_24H: 100000, // 从500000降低到100000
    
    // RSI阈值（扩大有效范围）
    RSI_LONG_MIN: 20,       // 做多RSI下限
    RSI_LONG_MAX: 70,       // 做多RSI上限（放宽）
    RSI_SHORT_MIN: 30,      // 做空RSI下限（放宽）
    RSI_SHORT_MAX: 80,      // 做空RSI上限
    
    // ATR阈值
    MIN_ATR_PERCENT: 0.3,   // 最小ATR百分比
    
    // 趋势强度阈值
    TREND_STRENGTH_MIN: 0.005  // 最小趋势强度
  }
};

// ==================== 工具函数 ====================

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
  
  const recentTR = trValues.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

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

function findSwingPoints(klines, lookback = 5) {
  const swingHighs = [];
  const swingLows = [];
  
  for (let i = lookback; i < klines.length - lookback; i++) {
    const current = klines[i];
    
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

function detectChoCH(klines, swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  
  const recentHighs = swingHighs.slice(-3);
  const recentLows = swingLows.slice(-3);
  
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

function detectFVG(klines) {
  const fvgList = [];
  
  for (let i = 2; i < klines.length; i++) {
    const k1 = klines[i - 2];
    const k2 = klines[i - 1];
    const k3 = klines[i];
    
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

function detectSweep(klines) {
  if (klines.length < 10) return null;
  
  const { swingHighs, swingLows } = findSwingPoints(klines, 3);
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  
  const recentKlines = klines.slice(-5);
  const lastKline = klines[klines.length - 1];
  
  const recentSwingHigh = swingHighs[swingHighs.length - 1];
  const recentSwingLow = swingLows[swingLows.length - 1];
  
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

function detectOrderBlocks(klines) {
  const obs = [];
  
  for (let i = 3; i < klines.length - 1; i++) {
    const k0 = klines[i - 1];
    const k1 = klines[i];
    const k2 = klines[i + 1];
    
    if (k0.close < k0.open && k1.close > k1.open && k1.close > k0.high && k2.close > k2.open) {
      obs.push({
        type: 'BULLISH_OB',
        high: k1.high,
        low: k1.low,
        timestamp: k1.timestamp,
        index: i,
        strength: (k1.close - k1.open) / k1.open
      });
    }
    
    if (k0.close > k0.open && k1.close < k1.open && k1.close < k0.low && k2.close < k2.open) {
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

// ==================== V2.0 核心：HTF Bias Gate ====================

/**
 * HTF Bias Gate - 高时间框架方向门控
 * @param {Array} klines - K线数据（4H）
 * @returns {Object} Bias分析结果
 */
function analyzeHTFBias(klines) {
  if (klines.length < 20) {
    return {
      bias: 'NEUTRAL',
      confidence: 'low',
      reason: 'INSUFFICIENT_DATA',
      details: { candleCount: klines.length }
    };
  }
  
  const recentKlines = klines.slice(-20);
  const sma = recentKlines.reduce((sum, k) => sum + k.close, 0) / 20;
  const currentPrice = klines[klines.length - 1].close;
  const priceChange = (currentPrice - sma) / sma;
  
  const rsi = calculateRSI(klines, 14);
  const atr = calculateATR(klines, 14);
  const avgPrice = klines.slice(-14).reduce((s, k) => s + k.close, 0) / 14;
  const volatility = (atr / avgPrice) * 100;
  
  // 确定Bias方向
  let bias = 'NEUTRAL';
  let confidence = 'medium';
  
  if (priceChange > 0.02) {
    bias = 'LONG';
    confidence = rsi > 50 ? 'high' : 'medium';
  } else if (priceChange > 0.005) {
    bias = 'LONG';
    confidence = 'low';
  } else if (priceChange < -0.02) {
    bias = 'SHORT';
    confidence = rsi < 50 ? 'high' : 'medium';
  } else if (priceChange < -0.005) {
    bias = 'SHORT';
    confidence = 'low';
  }
  
  // 检查结构确认
  const { swingHighs, swingLows } = findSwingPoints(klines);
  const choch = detectChoCH(klines, swingHighs, swingLows);
  const fvgList = detectFVG(klines);
  
  // 结构确认增强
  let structureConfirmed = false;
  if (choch) {
    if ((bias === 'LONG' && choch.type === 'BULLISH_CHOCH') ||
        (bias === 'SHORT' && choch.type === 'BEARISH_CHOCH')) {
      structureConfirmed = true;
      confidence = 'high';
    }
  }
  
  return {
    bias,
    confidence,
    structureConfirmed,
    priceChange,
    rsi,
    volatility,
    choch,
    fvgCount: fvgList.length,
    swingHighs: swingHighs.length,
    swingLows: swingLows.length,
    details: {
      sma,
      currentPrice,
      atr
    }
  };
}

// ==================== V2.0 核心：环境检查三态化 ====================

/**
 * 环境检查 - 三态输出：PASS / WARN / FAIL
 * @param {Array} klines - K线数据
 * @param {string} direction - 交易方向
 * @param {Object} ticker - 实时价格数据
 * @returns {Object} 环境检查结果
 */
function environmentCheckV2(klines, direction, ticker) {
  const checks = [];
  const warnings = [];
  const failures = [];
  
  const currentPrice = klines[klines.length - 1].close;
  const rsi = calculateRSI(klines, 14);
  const atr = calculateATR(klines, 14);
  const avgPrice = klines.slice(-14).reduce((s, k) => s + k.close, 0) / 14;
  const volatility = (atr / avgPrice) * 100;
  
  // 1. 数据新鲜度检查（硬FAIL）
  const dataFreshCheck = {
    name: 'DATA_FRESHNESS',
    passed: klines.length >= 50,
    value: klines.length,
    threshold: 50,
    severity: 'FAIL'  // 数据不新鲜是硬失败
  };
  checks.push(dataFreshCheck);
  if (!dataFreshCheck.passed) failures.push('DATA_INSUFFICIENT');
  
  // 2. 交易对可用性检查（硬FAIL）
  const tradableCheck = {
    name: 'TRADABLE',
    passed: !ticker || ticker.tradable !== false,
    value: ticker?.tradable,
    severity: 'FAIL'
  };
  checks.push(tradableCheck);
  if (!tradableCheck.passed) failures.push('NOT_TRADABLE');
  
  // 3. 成交量检查（WARN）
  const volumeCheck = {
    name: 'VOLUME',
    passed: !ticker || ticker.volume24h >= CONFIG.ENVIRONMENT.MIN_VOLUME_24H,
    value: ticker?.volume24h || 0,
    threshold: CONFIG.ENVIRONMENT.MIN_VOLUME_24H,
    severity: 'WARN'
  };
  checks.push(volumeCheck);
  if (!volumeCheck.passed) warnings.push('LOW_VOLUME');
  
  // 4. 波动率检查（WARN）
  const volatilityCheck = {
    name: 'VOLATILITY',
    passed: volatility >= CONFIG.ENVIRONMENT.MIN_VOLATILITY && volatility <= CONFIG.ENVIRONMENT.MAX_VOLATILITY,
    value: volatility,
    minThreshold: CONFIG.ENVIRONMENT.MIN_VOLATILITY,
    maxThreshold: CONFIG.ENVIRONMENT.MAX_VOLATILITY,
    severity: 'WARN'
  };
  checks.push(volatilityCheck);
  if (!volatilityCheck.passed) {
    if (volatility < CONFIG.ENVIRONMENT.MIN_VOLATILITY) warnings.push('VOLATILITY_TOO_LOW');
    if (volatility > CONFIG.ENVIRONMENT.MAX_VOLATILITY) warnings.push('VOLATILITY_TOO_HIGH');
  }
  
  // 5. RSI检查（WARN - 放宽范围）
  let rsiPassed = true;
  let rsiReason = null;
  if (direction === 'LONG') {
    rsiPassed = rsi >= CONFIG.ENVIRONMENT.RSI_LONG_MIN && rsi <= CONFIG.ENVIRONMENT.RSI_LONG_MAX;
    if (rsi < CONFIG.ENVIRONMENT.RSI_LONG_MIN) rsiReason = 'RSI_TOO_LOW_FOR_LONG';
    if (rsi > CONFIG.ENVIRONMENT.RSI_LONG_MAX) rsiReason = 'RSI_TOO_HIGH_FOR_LONG';
  } else {
    rsiPassed = rsi >= CONFIG.ENVIRONMENT.RSI_SHORT_MIN && rsi <= CONFIG.ENVIRONMENT.RSI_SHORT_MAX;
    if (rsi < CONFIG.ENVIRONMENT.RSI_SHORT_MIN) rsiReason = 'RSI_TOO_LOW_FOR_SHORT';
    if (rsi > CONFIG.ENVIRONMENT.RSI_SHORT_MAX) rsiReason = 'RSI_TOO_HIGH_FOR_SHORT';
  }
  
  const rsiCheck = {
    name: 'RSI',
    passed: rsiPassed,
    value: rsi,
    direction,
    severity: 'WARN'
  };
  checks.push(rsiCheck);
  if (!rsiPassed) warnings.push(rsiReason);
  
  // 6. ATR检查（WARN）
  const atrPercent = (atr / currentPrice) * 100;
  const atrCheck = {
    name: 'ATR',
    passed: atrPercent >= CONFIG.ENVIRONMENT.MIN_ATR_PERCENT,
    value: atrPercent,
    threshold: CONFIG.ENVIRONMENT.MIN_ATR_PERCENT,
    severity: 'WARN'
  };
  checks.push(atrCheck);
  if (!atrCheck.passed) warnings.push('ATR_TOO_LOW');
  
  // 确定最终状态
  let status = 'PASS';
  if (failures.length > 0) {
    status = 'FAIL';
  } else if (warnings.length > 0) {
    status = 'WARN';
  }
  
  // 计算环境评分（0-100）
  const totalChecks = checks.length;
  const passedChecks = checks.filter(c => c.passed).length;
  const environmentScore = Math.round((passedChecks / totalChecks) * 100);
  
  return {
    status,           // PASS / WARN / FAIL
    checks,           // 所有检查项详情
    warnings,         // 警告列表
    failures,         // 失败列表
    environmentScore, // 0-100评分
    environmentGrade: environmentScore >= 80 ? 'A' : environmentScore >= 60 ? 'B' : environmentScore >= 40 ? 'C' : 'D',
    debugValues: {    // 调试值
      rsi,
      atr: atrPercent,
      volatility,
      volume24h: ticker?.volume24h || 0,
      currentPrice
    }
  };
}

// ==================== V2.0 核心：LTF Entry Confirmation ====================

/**
 * LTF入场确认链
 * @param {Array} klines - K线数据
 * @param {string} direction - 交易方向
 * @returns {Object} 入场确认结果
 */
function analyzeLTFConfirmation(klines, direction) {
  const { swingHighs, swingLows } = findSwingPoints(klines);
  const choch = detectChoCH(klines, swingHighs, swingLows);
  const fvgList = detectFVG(klines);
  const sweep = detectSweep(klines);
  const obs = detectOrderBlocks(klines);
  
  const confirmations = [];
  const missingConfirmations = [];
  
  // 1. ChoCH/BOS确认
  if (choch) {
    const isAligned = (direction === 'LONG' && choch.type === 'BULLISH_CHOCH') ||
                      (direction === 'SHORT' && choch.type === 'BEARISH_CHOCH');
    confirmations.push({
      type: 'CHOCH',
      detected: true,
      aligned: isAligned,
      details: choch
    });
    if (!isAligned) missingConfirmations.push('CHOCH_NOT_ALIGNED');
  } else {
    confirmations.push({ type: 'CHOCH', detected: false });
    missingConfirmations.push('NO_CHOCH');
  }
  
  // 2. FVG作为POI
  if (fvgList.length > 0) {
    const relevantFVG = fvgList[fvgList.length - 1];
    const isAligned = (direction === 'LONG' && relevantFVG.type === 'BULLISH_FVG') ||
                      (direction === 'SHORT' && relevantFVG.type === 'BEARISH_FVG');
    confirmations.push({
      type: 'FVG',
      detected: true,
      aligned: isAligned,
      count: fvgList.length,
      details: relevantFVG
    });
    if (!isAligned) missingConfirmations.push('FVG_NOT_ALIGNED');
  } else {
    confirmations.push({ type: 'FVG', detected: false, count: 0 });
    missingConfirmations.push('NO_FVG');
  }
  
  // 3. 流动性扫荡
  if (sweep) {
    const isAligned = sweep.direction === direction;
    confirmations.push({
      type: 'SWEEP',
      detected: true,
      aligned: isAligned,
      details: sweep
    });
    if (!isAligned) missingConfirmations.push('SWEEP_NOT_ALIGNED');
  } else {
    confirmations.push({ type: 'SWEEP', detected: false });
    missingConfirmations.push('NO_SWEEP');
  }
  
  // 4. 订单块
  if (obs.length > 0) {
    const relevantOB = obs[obs.length - 1];
    const isAligned = (direction === 'LONG' && relevantOB.type === 'BULLISH_OB') ||
                      (direction === 'SHORT' && relevantOB.type === 'BEARISH_OB');
    confirmations.push({
      type: 'ORDER_BLOCK',
      detected: true,
      aligned: isAligned,
      count: obs.length,
      details: relevantOB
    });
    if (!isAligned) missingConfirmations.push('OB_NOT_ALIGNED');
  } else {
    confirmations.push({ type: 'ORDER_BLOCK', detected: false, count: 0 });
    missingConfirmations.push('NO_ORDER_BLOCK');
  }
  
  // 计算确认度（0-100）
  const confirmedCount = confirmations.filter(c => c.detected && c.aligned).length;
  const confirmationScore = Math.round((confirmedCount / 4) * 100);
  
  return {
    confirmations,
    missingConfirmations,
    confirmationScore,
    confirmationGrade: confirmationScore >= 75 ? 'STRONG' : confirmationScore >= 50 ? 'MODERATE' : confirmationScore >= 25 ? 'WEAK' : 'NONE',
    canEnter: confirmationScore >= 50,  // 至少50%确认度才能入场
    choch,
    fvgList,
    sweep,
    obs
  };
}

// ==================== V2.0 核心：候选信号生成 ====================

/**
 * 生成候选信号（即使不满足所有确认条件）
 * @param {string} symbol - 交易对
 * @param {Object} htfBias - HTF Bias结果
 * @param {Object} ltfConfirm - LTF确认结果
 * @param {Object} envCheck - 环境检查结果
 * @param {Array} klines - K线数据
 * @param {Object} ticker - 实时价格数据
 * @returns {Object} 候选信号
 */
function generateCandidateSignal(symbol, htfBias, ltfConfirm, envCheck, klines, ticker) {
  const direction = htfBias.bias;
  const currentPrice = klines[klines.length - 1].close;
  
  // 计算入场/止损/止盈
  let entryPrice = currentPrice;
  let stopLoss, tp1, tp2;
  
  const atr = calculateATR(klines, 14);
  const relevantFVG = ltfConfirm.fvgList?.length > 0 ? ltfConfirm.fvgList[ltfConfirm.fvgList.length - 1] : null;
  
  if (direction === 'LONG') {
    if (relevantFVG && relevantFVG.type === 'BULLISH_FVG') {
      entryPrice = relevantFVG.top;
      stopLoss = Math.min(relevantFVG.bottom, currentPrice - atr * 1.5);
    } else {
      stopLoss = currentPrice - atr * 1.5;
    }
    tp1 = entryPrice + (entryPrice - stopLoss) * 2;
    tp2 = entryPrice + (entryPrice - stopLoss) * 3;
  } else {
    if (relevantFVG && relevantFVG.type === 'BEARISH_FVG') {
      entryPrice = relevantFVG.bottom;
      stopLoss = Math.max(relevantFVG.top, currentPrice + atr * 1.5);
    } else {
      stopLoss = currentPrice + atr * 1.5;
    }
    tp1 = entryPrice - (stopLoss - entryPrice) * 2;
    tp2 = entryPrice - (stopLoss - entryPrice) * 3;
  }
  
  const risk = Math.abs(entryPrice - stopLoss);
  const rrr = risk > 0 ? Math.abs(tp1 - entryPrice) / risk : 0;
  
  // 评分计算
  let baseScore = 50;  // 候选信号基础分较低
  
  // HTF Bias加分
  if (htfBias.confidence === 'high') baseScore += 10;
  else if (htfBias.confidence === 'medium') baseScore += 5;
  
  // 结构确认加分
  if (htfBias.structureConfirmed) baseScore += 10;
  
  // LTF确认加分
  const confirmedCount = ltfConfirm.confirmations?.filter(c => c.detected && c.aligned).length || 0;
  baseScore += confirmedCount * 5;
  
  // 环境评分加权
  baseScore += (envCheck.environmentScore || 0) * 0.2;
  
  // 确定信号类型 (V2.1: 三档分类)
  // Type A: 完全确认 (TRADABLE) - 所有关键条件满足
  // Type B: 部分确认 (PARTIAL) - 环境健康，但缺少1-2个确认条件
  // Type C: 候选/等待 (CANDIDATE) - 缺少多个确认条件
  let signalType, entryType, statusDesc;
  
  const confirmedCount = ltfConfirm.confirmations.filter(c => c.detected && c.aligned).length;
  const missingCritical = ltfConfirm.missingConfirmations.filter(m => 
    ['NO_CHOCH', 'NO_SWEEP', 'NO_FVG'].includes(m)
  ).length;
  
  if (ltfConfirm.canEnter && confirmedCount >= 3 && envCheck.status === 'PASS') {
    // Type A: 完全确认
    signalType = 'TRADABLE';
    entryType = 'A';
    statusDesc = '等待入场';
  } else if (envCheck.status !== 'FAIL' && confirmedCount >= 2 && htfBias.structureConfirmed) {
    // Type B: 部分确认 - 环境健康，有2+确认，结构已确认
    signalType = 'PARTIAL';
    entryType = 'B';
    statusDesc = '部分确认';
  } else {
    // Type C: 候选/等待
    signalType = 'CANDIDATE';
    entryType = 'C';
    statusDesc = '等待确认';
  }
  
  // 确定评级
  let rating = 'C';
  if (baseScore >= CONFIG.SCORE_THRESHOLDS.S) rating = 'S';
  else if (baseScore >= CONFIG.SCORE_THRESHOLDS.A) rating = 'A';
  else if (baseScore >= CONFIG.SCORE_THRESHOLDS.B) rating = 'B';
  
  // 如果是候选信号，评级降级
  if (signalType === 'CANDIDATE' && rating !== 'C') {
    rating = rating === 'S' ? 'A' : rating === 'A' ? 'B' : 'C';
  }
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  
  // 计算过期时间（分钟）
  const expiresInMinutes = Math.round((expiresAt - now) / (60 * 1000));
  
  // 生成标签
  const tags = [];
  if (ltfConfirm.choch) tags.push('ChoCH');
  if (ltfConfirm.fvgList?.length > 0) tags.push('FVG');
  if (ltfConfirm.sweep) tags.push('Sweep');
  if (ltfConfirm.obs?.length > 0) tags.push('OB');
  if (signalType === 'PARTIAL') tags.push('部分确认');
  if (signalType === 'CANDIDATE') tags.push('候选');
  
  // 获取FVG和ChoCH的价格水平
  let fvgTop = 0;
  let fvgBottom = 0;
  
  if (ltfConfirm.fvgList && ltfConfirm.fvgList.length > 0) {
    const relevantFVG = ltfConfirm.fvgList.find(f => {
      if (direction === 'LONG' && f.type === 'BULLISH_FVG') return true;
      if (direction === 'SHORT' && f.type === 'BEARISH_FVG') return true;
      return false;
    });
    if (relevantFVG) {
      fvgTop = relevantFVG.top || 0;
      fvgBottom = relevantFVG.bottom || 0;
    }
  }
  
  const chochLevel = ltfConfirm.choch?.level || 0;
  const sweepLevel = ltfConfirm.sweep?.sweptLevel || 0;
  
  return {
    id: `${symbol}_${Date.now()}`,
    symbol,
    direction,
    current_price: currentPrice,
    entry_price: entryPrice,
    entry_type: entryType,
    sl: stopLoss,
    tp1,
    tp2,
    rrr,
    rating,
    score: Math.round(baseScore),
    atr,
    rsi: htfBias.rsi,
    tags,
    has_choch: !!ltfConfirm.choch,
    has_fvg: ltfConfirm.fvgList?.length > 0,
    has_sweep: !!ltfConfirm.sweep,
    fvg_top: fvgTop,
    fvg_bottom: fvgBottom,
    choch_level: chochLevel,
    sweep_level: sweepLevel,
    
    // V2.0新增字段
    signal_type: signalType,
    status: signalType === 'TRADABLE' ? 'ACTIVE' : 'PENDING',
    status_desc: statusDesc,
    expires_in_minutes: expiresInMinutes,
    
    // HTF分析
    htf_bias: {
      bias: htfBias.bias,
      confidence: htfBias.confidence,
      structure_confirmed: htfBias.structureConfirmed,
      price_change: htfBias.priceChange,
      rsi: htfBias.rsi,
      volatility: htfBias.volatility
    },
    
    // LTF确认
    ltf_confirmation: {
      confirmation_score: ltfConfirm.confirmationScore,
      confirmation_grade: ltfConfirm.confirmationGrade,
      confirmations: ltfConfirm.confirmations,
      missing_confirmations: ltfConfirm.missingConfirmations
    },
    
    // 环境检查
    environment: {
      status: envCheck.status,
      score: envCheck.environmentScore,
      grade: envCheck.environmentGrade,
      warnings: envCheck.warnings,
      failures: envCheck.failures,
      debug_values: envCheck.debugValues
    },
    
    // 结构特征
    structure: {
      choch: ltfConfirm.choch,
      sweep: ltfConfirm.sweep,
      fvg: ltfConfirm.fvgList?.[ltfConfirm.fvgList.length - 1] || null,
      order_blocks: ltfConfirm.obs?.slice(-2) || []
    },
    
    // 时间戳
    timestamp: now.toISOString(),
    trigger_time: now.getTime(),
    kline_time: klines[klines.length - 1].timestamp,
    expires_at: expiresAt.toISOString(),
    timeframe: '4H',
    data_source: 'Gate.io API',
    data_health: 'HEALTHY'
  };
}

// ==================== V2.0 扫描主函数 ====================

/**
 * V2.0 扫描所有交易对
 * @param {Object} klinesData - K线数据对象
 * @param {Object} tickersData - 实时价格数据
 * @param {Array} scanHistory - 扫描历史
 * @returns {Object} 扫描结果
 */
function scanAllSymbolsV2(klinesData, tickersData, scanHistory = []) {
  const tradableSignals = [];
  const candidateSignals = [];
  const filtered = [];
  const debugInfo = [];
  
  for (const [symbol, klines] of Object.entries(klinesData)) {
    try {
      const ticker = tickersData ? tickersData[symbol] : null;
      
      // ========== 步骤1: HTF Bias分析 ==========
      const htfBias = analyzeHTFBias(klines);
      
      // 如果Bias为NEUTRAL且置信度低，仍然继续（产出候选）
      if (htfBias.bias === 'NEUTRAL' && htfBias.confidence === 'low') {
        // 不阻断，继续分析
      }
      
      // ========== 步骤2: 环境检查（三态）==========
      const direction = htfBias.bias === 'NEUTRAL' ? 
        (htfBias.rsi > 50 ? 'LONG' : 'SHORT') : htfBias.bias;
      
      const envCheck = environmentCheckV2(klines, direction, ticker);
      
      // 硬FAIL才阻断
      if (envCheck.status === 'FAIL') {
        filtered.push({
          symbol,
          reason: 'ENVIRONMENT_FAIL',
          sub_reasons: envCheck.failures,
          environment_score: envCheck.environmentScore,
          debug_values: envCheck.debugValues
        });
        
        debugInfo.push({
          symbol,
          stage: 'ENVIRONMENT_CHECK',
          htf_bias: htfBias,
          env_check: envCheck,
          blocked: true
        });
        
        continue;
      }
      
      // ========== 步骤3: LTF入场确认 ==========
      const ltfConfirm = analyzeLTFConfirmation(klines, direction);
      
      // ========== 步骤4: 生成信号（TRADABLE或CANDIDATE）==========
      const signal = generateCandidateSignal(
        symbol, htfBias, ltfConfirm, envCheck, klines, ticker
      );
      
      // 分类存储
      if (signal.signal_type === 'TRADABLE') {
        tradableSignals.push(signal);
      } else {
        candidateSignals.push(signal);
      }
      
      // 记录调试信息
      debugInfo.push({
        symbol,
        stage: 'SIGNAL_GENERATED',
        htf_bias: htfBias,
        env_check: envCheck,
        ltf_confirm: ltfConfirm,
        signal_type: signal.signal_type,
        blocked: false
      });
      
    } catch (error) {
      console.error(`Error analyzing ${symbol}:`, error.message);
      filtered.push({
        symbol,
        reason: 'ANALYSIS_ERROR',
        error: error.message
      });
    }
  }
  
  return {
    tradable_signals: tradableSignals,
    candidate_signals: candidateSignals,
    filtered,
    debug_info: debugInfo,
    summary: {
      total: Object.keys(klinesData).length,
      tradable: tradableSignals.length,
      candidates: candidateSignals.length,
      filtered: filtered.length
    }
  };
}

// ==================== 导出 ====================

module.exports = {
  CONFIG,
  // 工具函数
  calculateATR,
  calculateRSI,
  findSwingPoints,
  detectChoCH,
  detectFVG,
  detectSweep,
  detectOrderBlocks,
  
  // V2.0核心函数
  analyzeHTFBias,
  environmentCheckV2,
  analyzeLTFConfirmation,
  generateCandidateSignal,
  scanAllSymbolsV2
};
