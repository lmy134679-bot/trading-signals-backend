/**
 * 多时间框架分析模块 (MTF - Multi Timeframe Analysis)
 * 
 * 实现ICT/SMC三层时间框架体系：
 * - HTF (4H): 战略方向与关键区域(POI)
 * - MTF (15M): 战术确认(CHoCH+BOS)
 * - LTF (1M): 精准执行(入场触发)
 * 
 * 核心原则：瀑布流逐级确认，方向冲突时以高周期为准
 */

const {
  findSwingPoints,
  detectChoCH,
  detectFVG,
  detectSweep,
  detectOrderBlocks,
  determineTrendDetailed,
  calculateATR
} = require('./strategy');

// MTF配置
const MTF_CONFIG = {
  // 时间框架定义
  TIMEFRAMES: {
    HTF: { name: '4h', description: '战略方向与关键区域' },
    MTF: { name: '15m', description: '战术确认' },
    LTF: { name: '1m', description: '精准执行' }
  },
  
  // 对齐门控配置
  ALIGNMENT_GATE: {
    enabled: true,
    // 当为true时，任何一层方向冲突则阻断信号
    strictMode: true,
    // 冲突时的降级策略: 'BLOCK' | 'DOWNGRADE'
    conflictAction: 'BLOCK'
  },
  
  // BOS确认配置
  BOS_CONFIRMATION: {
    enabled: true,
    // 强力收盘确认开关
    strongCloseRequired: false,
    // 实体突破要求
    bodyBreakRequired: true
  }
};

/**
 * HTF分析 - 战略方向与关键区域
 * @param {Array} klines - 4H K线数据
 * @returns {Object} HTF分析结果
 */
function analyzeHTF(klines) {
  if (!klines || klines.length < 20) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_DATA',
      direction: 'NEUTRAL'
    };
  }
  
  const { swingHighs, swingLows } = findSwingPoints(klines, 5);
  const trend = determineTrendDetailed(klines);
  const fvgList = detectFVG(klines);
  const obs = detectOrderBlocks(klines);
  
  // 确定战略方向
  let direction = 'NEUTRAL';
  if (trend.direction === 'BULLISH' || trend.direction === 'WEAK_BULLISH') {
    direction = 'LONG';
  } else if (trend.direction === 'BEARISH' || trend.direction === 'WEAK_BEARISH') {
    direction = 'SHORT';
  }
  
  // 标记关键区域(POI - Points of Interest)
  const poiList = [];
  
  // 1. 未测试的FVG作为POI
  fvgList.slice(-3).forEach(fvg => {
    const currentPrice = klines[klines.length - 1].close;
    const isTested = direction === 'LONG' 
      ? currentPrice <= fvg.top 
      : currentPrice >= fvg.bottom;
    
    poiList.push({
      type: 'FVG',
      subtype: fvg.type,
      top: fvg.top,
      bottom: fvg.bottom,
      timeframe: '4h',
      tested: isTested,
      priority: fvg.sizePercent > 0.5 ? 'high' : 'medium'
    });
  });
  
  // 2. 订单块作为POI
  obs.slice(-2).forEach(ob => {
    poiList.push({
      type: 'ORDER_BLOCK',
      subtype: ob.type,
      top: ob.high,
      bottom: ob.low,
      timeframe: '4h',
      tested: false,
      priority: ob.strength > 0.02 ? 'high' : 'medium'
    });
  });
  
  // 3. 流动性池
  if (swingHighs.length > 0) {
    const recentHigh = swingHighs[swingHighs.length - 1];
    poiList.push({
      type: 'LIQUIDITY_POOL',
      subtype: 'BUY_SIDE',
      level: recentHigh.price,
      timeframe: '4h',
      priority: 'high'
    });
  }
  
  if (swingLows.length > 0) {
    const recentLow = swingLows[swingLows.length - 1];
    poiList.push({
      type: 'LIQUIDITY_POOL',
      subtype: 'SELL_SIDE',
      level: recentLow.price,
      timeframe: '4h',
      priority: 'high'
    });
  }
  
  return {
    valid: true,
    direction,
    trend,
    swingHighs,
    swingLows,
    poi: poiList,
    fvg: fvgList.slice(-3),
    orderBlocks: obs.slice(-2),
    currentPrice: klines[klines.length - 1].close,
    atr: calculateATR(klines, 14)
  };
}

/**
 * MTF分析 - 战术确认(CHoCH+BOS)
 * @param {Array} klines - 15M K线数据
 * @param {string} htfDirection - HTF方向
 * @param {Array} htfPOI - HTF关键区域
 * @returns {Object} MTF分析结果
 */
function analyzeMTF(klines, htfDirection, htfPOI) {
  if (!klines || klines.length < 20) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_DATA',
      direction: 'NEUTRAL',
      aligned: false
    };
  }
  
  const { swingHighs, swingLows } = findSwingPoints(klines, 3);
  const choch = detectChoCH(klines, swingHighs, swingLows);
  const fvgList = detectFVG(klines);
  
  // 检测BOS
  const bos = detectBOS(klines, swingHighs, swingLows);
  
  // 强力收盘确认
  const strongCloseConfirmed = bos ? confirmStrongClose(klines, bos) : false;
  
  // 确定MTF方向
  let direction = 'NEUTRAL';
  if (choch) {
    direction = choch.type === 'BULLISH_CHOCH' ? 'LONG' : 'SHORT';
  } else if (bos) {
    direction = bos.type === 'BULLISH_BOS' ? 'LONG' : 'SHORT';
  }
  
  // 检查是否在HTF POI内
  const currentPrice = klines[klines.length - 1].close;
  const inHTFPOI = checkPriceInPOI(currentPrice, htfPOI);
  
  // 对齐检查
  const aligned = direction === htfDirection || htfDirection === 'NEUTRAL';
  
  return {
    valid: true,
    direction,
    choch,
    bos,
    strongCloseConfirmed,
    swingHighs,
    swingLows,
    fvg: fvgList.slice(-2),
    inHTFPOI,
    aligned,
    alignmentCheck: {
      htfDirection,
      mtfDirection: direction,
      conflict: !aligned && direction !== 'NEUTRAL',
      conflictReason: !aligned ? `MTF方向(${direction})与HTF方向(${htfDirection})冲突` : null
    },
    currentPrice
  };
}

/**
 * LTF分析 - 精准执行
 * @param {Array} klines - 1M K线数据
 * @param {string} htfDirection - HTF方向
 * @param {string} mtfDirection - MTF方向
 * @param {Array} mtfFVG - MTF的FVG列表
 * @returns {Object} LTF分析结果
 */
function analyzeLTF(klines, htfDirection, mtfDirection, mtfFVG) {
  if (!klines || klines.length < 20) {
    return {
      valid: false,
      reason: 'INSUFFICIENT_DATA',
      direction: 'NEUTRAL',
      aligned: false
    };
  }
  
  const { swingHighs, swingLows } = findSwingPoints(klines, 2);
  const choch = detectChoCH(klines, swingHighs, swingLows);
  const sweep = detectSweep(klines);
  const fvgList = detectFVG(klines);
  
  // 检测内部结构突破
  const internalBOS = detectInternalBOS(klines, swingHighs, swingLows);
  
  // 高二/低二计数
  const hiloCount = detectHiLoTwo(klines, htfDirection);
  
  // 确定LTF方向
  let direction = 'NEUTRAL';
  if (choch) {
    direction = choch.type === 'BULLISH_CHOCH' ? 'LONG' : 'SHORT';
  } else if (internalBOS) {
    direction = internalBOS.type === 'BULLISH_BOS' ? 'LONG' : 'SHORT';
  }
  
  // 对齐检查
  const aligned = direction === htfDirection && direction === mtfDirection;
  
  // 入场区域检查
  const currentPrice = klines[klines.length - 1].close;
  const inEntryZone = mtfFVG && mtfFVG.length > 0 
    ? checkPriceInFVG(currentPrice, mtfFVG[mtfFVG.length - 1])
    : false;
  
  return {
    valid: true,
    direction,
    choch,
    sweep,
    internalBOS,
    hiloCount,
    fvg: fvgList.slice(-2),
    inEntryZone,
    aligned,
    alignmentCheck: {
      htfDirection,
      mtfDirection,
      ltfDirection: direction,
      fullyAligned: aligned,
      partialAlignment: direction === htfDirection || direction === mtfDirection
    },
    currentPrice
  };
}

/**
 * 检测BOS (Break of Structure)
 * @param {Array} klines - K线数据
 * @param {Array} swingHighs - 摆动高点
 * @param {Array} swingLows - 摆动低点
 * @returns {Object|null} BOS检测结果
 */
function detectBOS(klines, swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return null;
  
  const lastKline = klines[klines.length - 1];
  const prevSwingHigh = swingHighs[swingHighs.length - 2];
  const prevSwingLow = swingLows[swingLows.length - 2];
  
  // 看涨BOS: 突破前高
  const bodyTop = Math.max(lastKline.open, lastKline.close);
  const bodyBottom = Math.min(lastKline.open, lastKline.close);
  
  if (bodyTop > prevSwingHigh.price && lastKline.close > prevSwingHigh.price) {
    return {
      type: 'BULLISH_BOS',
      brokenLevel: prevSwingHigh.price,
      closePrice: lastKline.close,
      bodyBreak: true,
      timestamp: lastKline.timestamp
    };
  }
  
  // 看跌BOS: 突破前低
  if (bodyBottom < prevSwingLow.price && lastKline.close < prevSwingLow.price) {
    return {
      type: 'BEARISH_BOS',
      brokenLevel: prevSwingLow.price,
      closePrice: lastKline.close,
      bodyBreak: true,
      timestamp: lastKline.timestamp
    };
  }
  
  return null;
}

/**
 * 强力收盘确认
 * @param {Array} klines - K线数据
 * @param {Object} bos - BOS检测结果
 * @returns {boolean} 是否确认
 */
function confirmStrongClose(klines, bos) {
  if (klines.length < 2) return false;
  
  const confirmKline = klines[klines.length - 1];
  const breakKline = klines[klines.length - 2];
  
  // 位置确认: 确认K线收盘仍在突破位之外
  let positionConfirmed = false;
  if (bos.type === 'BULLISH_BOS') {
    positionConfirmed = confirmKline.close > bos.brokenLevel;
  } else {
    positionConfirmed = confirmKline.close < bos.brokenLevel;
  }
  
  // 动能确认: 确认K线颜色与突破方向一致
  let momentumConfirmed = false;
  if (bos.type === 'BULLISH_BOS') {
    momentumConfirmed = confirmKline.close > confirmKline.open; // 阳线
  } else {
    momentumConfirmed = confirmKline.close < confirmKline.open; // 阴线
  }
  
  return positionConfirmed && momentumConfirmed;
}

/**
 * 检测内部结构突破 (LTF级别)
 * @param {Array} klines - K线数据
 * @param {Array} swingHighs - 摆动高点
 * @param {Array} swingLows - 摆动低点
 * @returns {Object|null} 内部BOS
 */
function detectInternalBOS(klines, swingHighs, swingLows) {
  // 使用更短的摆动点检测内部结构
  const recentKlines = klines.slice(-10);
  const { swingHighs: internalHighs, swingLows: internalLows } = findSwingPoints(recentKlines, 2);
  
  if (internalHighs.length < 2 && internalLows.length < 2) return null;
  
  const lastKline = klines[klines.length - 1];
  
  // 内部看涨突破
  if (internalHighs.length >= 2) {
    const prevInternalHigh = internalHighs[internalHighs.length - 2];
    if (lastKline.close > prevInternalHigh.price) {
      return {
        type: 'BULLISH_INTERNAL_BOS',
        brokenLevel: prevInternalHigh.price,
        timestamp: lastKline.timestamp
      };
    }
  }
  
  // 内部看跌突破
  if (internalLows.length >= 2) {
    const prevInternalLow = internalLows[internalLows.length - 2];
    if (lastKline.close < prevInternalLow.price) {
      return {
        type: 'BEARISH_INTERNAL_BOS',
        brokenLevel: prevInternalLow.price,
        timestamp: lastKline.timestamp
      };
    }
  }
  
  return null;
}

/**
 * 高二/低二计数法
 * @param {Array} klines - K线数据
 * @param {string} direction - 预期方向
 * @returns {Object} 计数结果
 */
function detectHiLoTwo(klines, direction) {
  if (klines.length < 10) {
    return { valid: false, reason: 'INSUFFICIENT_DATA' };
  }
  
  const recentKlines = klines.slice(-10);
  
  if (direction === 'LONG') {
    return countHighs(recentKlines);
  } else if (direction === 'SHORT') {
    return countLows(recentKlines);
  }
  
  return { valid: false, reason: 'NO_DIRECTION' };
}

/**
 * 数高 (做多场景)
 * @param {Array} klines - K线数据
 * @returns {Object} 计数结果
 */
function countHighs(klines) {
  let highOneIndex = -1;
  let highTwoIndex = -1;
  let pullbackIndex = -1;
  
  for (let i = 1; i < klines.length; i++) {
    const current = klines[i];
    const prev = klines[i - 1];
    
    // 检测高一
    if (highOneIndex === -1 && current.high > prev.high) {
      highOneIndex = i;
      continue;
    }
    
    // 检测回落
    if (highOneIndex !== -1 && pullbackIndex === -1 && current.high < klines[highOneIndex].high) {
      pullbackIndex = i;
      continue;
    }
    
    // 检测高二
    if (highOneIndex !== -1 && pullbackIndex !== -1 && current.high > klines[pullbackIndex].high) {
      highTwoIndex = i;
      break;
    }
  }
  
  // 检查是否处于震荡
  const isRanging = checkRanging(klines);
  
  if (highTwoIndex !== -1 && !isRanging) {
    return {
      valid: true,
      type: 'HIGH_TWO',
      highOneIndex,
      pullbackIndex,
      highTwoIndex,
      entryPrice: klines[highTwoIndex].high * 1.001, // 高点上方0.1%
      stopLoss: Math.min(...klines.slice(pullbackIndex, highTwoIndex).map(k => k.low)) * 0.999,
      countingPaused: false
    };
  }
  
  // 返回当前计数状态
  if (isRanging) {
    return {
      valid: false,
      type: highOneIndex !== -1 ? 'HIGH_ONE' : 'NONE',
      countingPaused: true,
      pauseReason: 'PRICE_RANGING',
      highOneIndex
    };
  }
  
  return {
    valid: false,
    type: highOneIndex !== -1 ? 'HIGH_ONE' : 'NONE',
    highOneIndex,
    pullbackIndex,
    countingPaused: false
  };
}

/**
 * 数低 (做空场景)
 * @param {Array} klines - K线数据
 * @returns {Object} 计数结果
 */
function countLows(klines) {
  let lowOneIndex = -1;
  let lowTwoIndex = -1;
  let pullbackIndex = -1;
  
  for (let i = 1; i < klines.length; i++) {
    const current = klines[i];
    const prev = klines[i - 1];
    
    // 检测低一
    if (lowOneIndex === -1 && current.low < prev.low) {
      lowOneIndex = i;
      continue;
    }
    
    // 检测反弹
    if (lowOneIndex !== -1 && pullbackIndex === -1 && current.low > klines[lowOneIndex].low) {
      pullbackIndex = i;
      continue;
    }
    
    // 检测低二
    if (lowOneIndex !== -1 && pullbackIndex !== -1 && current.low < klines[pullbackIndex].low) {
      lowTwoIndex = i;
      break;
    }
  }
  
  // 检查是否处于震荡
  const isRanging = checkRanging(klines);
  
  if (lowTwoIndex !== -1 && !isRanging) {
    return {
      valid: true,
      type: 'LOW_TWO',
      lowOneIndex,
      pullbackIndex,
      lowTwoIndex,
      entryPrice: klines[lowTwoIndex].low * 0.999, // 低点下方0.1%
      stopLoss: Math.max(...klines.slice(pullbackIndex, lowTwoIndex).map(k => k.high)) * 1.001,
      countingPaused: false
    };
  }
  
  // 返回当前计数状态
  if (isRanging) {
    return {
      valid: false,
      type: lowOneIndex !== -1 ? 'LOW_ONE' : 'NONE',
      countingPaused: true,
      pauseReason: 'PRICE_RANGING',
      lowOneIndex
    };
  }
  
  return {
    valid: false,
    type: lowOneIndex !== -1 ? 'LOW_ONE' : 'NONE',
    lowOneIndex,
    pullbackIndex,
    countingPaused: false
  };
}

/**
 * 检查是否处于震荡区间
 * @param {Array} klines - K线数据
 * @returns {boolean} 是否震荡
 */
function checkRanging(klines) {
  if (klines.length < 8) return false;
  
  const recent = klines.slice(-8);
  const highs = recent.map(k => k.high);
  const lows = recent.map(k => k.low);
  
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const range = maxHigh - minLow;
  const midPrice = (maxHigh + minLow) / 2;
  const rangePercent = (range / midPrice) * 100;
  
  // 如果区间小于1.5%且多次触碰高低点，认为是震荡
  const highTouches = highs.filter(h => h > maxHigh * 0.998).length;
  const lowTouches = lows.filter(l => l < minLow * 1.002).length;
  
  return rangePercent < 1.5 && highTouches >= 2 && lowTouches >= 2;
}

/**
 * 检查价格是否在POI内
 * @param {number} price - 当前价格
 * @param {Array} poiList - POI列表
 * @returns {boolean} 是否在POI内
 */
function checkPriceInPOI(price, poiList) {
  if (!poiList || poiList.length === 0) return false;
  
  return poiList.some(poi => {
    if (poi.type === 'FVG' || poi.type === 'ORDER_BLOCK') {
      return price >= poi.bottom && price <= poi.top;
    }
    return false;
  });
}

/**
 * 检查价格是否在FVG内
 * @param {number} price - 当前价格
 * @param {Object} fvg - FVG对象
 * @returns {boolean} 是否在FVG内
 */
function checkPriceInFVG(price, fvg) {
  if (!fvg) return false;
  return price >= fvg.bottom && price <= fvg.top;
}

/**
 * MTF对齐门控检查
 * @param {Object} htf - HTF分析结果
 * @param {Object} mtf - MTF分析结果
 * @param {Object} ltf - LTF分析结果
 * @returns {Object} 门控结果
 */
function checkAlignmentGate(htf, mtf, ltf) {
  const result = {
    passed: true,
    blocked: false,
    blockReason: null,
    details: {}
  };
  
  // 检查数据有效性
  if (!htf.valid) {
    result.passed = false;
    result.blocked = true;
    result.blockReason = 'HTF_DATA_INVALID';
    result.details.htf = htf.reason;
    return result;
  }
  
  if (!mtf.valid) {
    result.passed = false;
    result.blocked = true;
    result.blockReason = 'MTF_DATA_INVALID';
    result.details.mtf = mtf.reason;
    return result;
  }
  
  if (!ltf.valid) {
    result.passed = false;
    result.blocked = true;
    result.blockReason = 'LTF_DATA_INVALID';
    result.details.ltf = ltf.reason;
    return result;
  }
  
  // 检查HTF方向
  if (htf.direction === 'NEUTRAL') {
    result.passed = false;
    result.blocked = true;
    result.blockReason = 'HTF_DIRECTION_NEUTRAL';
    result.details.htfDirection = htf.direction;
    return result;
  }
  
  // 检查MTF对齐
  if (!mtf.aligned) {
    result.passed = false;
    result.blocked = MTF_CONFIG.ALIGNMENT_GATE.strictMode;
    result.blockReason = 'MTF_NOT_ALIGNED';
    result.details.mtfConflict = mtf.alignmentCheck.conflictReason;
    return result;
  }
  
  // 检查MTF是否在HTF POI内
  if (!mtf.inHTFPOI) {
    result.passed = false;
    result.blocked = MTF_CONFIG.ALIGNMENT_GATE.strictMode;
    result.blockReason = 'MTF_NOT_IN_HTF_POI';
    result.details.mtfInPOI = false;
    return result;
  }
  
  // 检查LTF对齐
  if (!ltf.aligned) {
    result.passed = false;
    result.blocked = MTF_CONFIG.ALIGNMENT_GATE.strictMode;
    result.blockReason = 'LTF_NOT_FULLY_ALIGNED';
    result.details.ltfAlignment = ltf.alignmentCheck;
    return result;
  }
  
  // 检查LTF是否在入场区域
  if (!ltf.inEntryZone) {
    result.passed = false;
    result.blockReason = 'LTF_NOT_IN_ENTRY_ZONE';
    result.details.inEntryZone = false;
    return result;
  }
  
  return result;
}

/**
 * 完整MTF分析
 * @param {Object} mtfData - 多时间框架数据 { '4h': [...], '15m': [...], '1m': [...] }
 * @returns {Object} 完整分析结果
 */
function analyzeMultiTimeframe(mtfData) {
  const htfKlines = mtfData['4h'];
  const mtfKlines = mtfData['15m'];
  const ltfKlines = mtfData['1m'];
  
  // 各层级分析
  const htf = analyzeHTF(htfKlines);
  const mtf = analyzeMTF(mtfKlines, htf.direction, htf.poi);
  const ltf = analyzeLTF(ltfKlines, htf.direction, mtf.direction, mtf.fvg);
  
  // 对齐门控
  const gate = checkAlignmentGate(htf, mtf, ltf);
  
  return {
    htf,
    mtf,
    ltf,
    gate,
    aligned: gate.passed,
    canGenerateSignal: gate.passed && !gate.blocked,
    blockedReason: gate.blockReason,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  MTF_CONFIG,
  analyzeHTF,
  analyzeMTF,
  analyzeLTF,
  analyzeMultiTimeframe,
  detectBOS,
  confirmStrongClose,
  detectInternalBOS,
  detectHiLoTwo,
  countHighs,
  countLows,
  checkRanging,
  checkAlignmentGate,
  checkPriceInPOI,
  checkPriceInFVG
};
