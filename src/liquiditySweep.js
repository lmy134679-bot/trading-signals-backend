/**
 * 流动性扫荡前置纪律模块
 * 
 * 核心原则：价格进入POI后不要立刻行动，优先等待一次清晰的流动性扫荡
 * 扫荡方向需与预期交易方向相反（做多先扫sell-side，做空先扫buy-side）
 */

const { findSwingPoints } = require('./strategy');

// 流动性扫荡配置
const SWEEP_CONFIG = {
  // 引线比例要求: 引线长度 > 实体长度 × 该系数
  WICK_RATIO: 2.0,
  
  // 回收比例要求: 回收幅度 > 引线长度 × 该系数
  RECLAIM_RATIO: 0.5,
  
  // 扫荡后确认要求: 需要后续K线确认反转
  CONFIRMATION_REQUIRED: true,
  
  // 扫荡有效性时间窗口（K线数量）
  VALIDITY_WINDOW: 5,
  
  // 最小扫荡幅度（相对于价格）
  MIN_SWEEP_PERCENT: 0.1
};

/**
 * 识别流动性池
 * @param {Array} klines - K线数据
 * @param {number} lookback - 回望周期
 * @returns {Object} 流动性池
 */
function identifyLiquidityPools(klines, lookback = 20) {
  const { swingHighs, swingLows } = findSwingPoints(klines, 3);
  
  const pools = {
    buySide: [],  // 买方流动性 - 摆动高点上方（做空时会被扫）
    sellSide: []  // 卖方流动性 - 摆动低点下方（做多时会被扫）
  };
  
  // 收集买方流动性池（摆动高点）
  swingHighs.slice(-5).forEach((swing, index) => {
    pools.buySide.push({
      type: 'SWING_HIGH',
      level: swing.price,
      index: swing.index,
      timestamp: swing.timestamp,
      priority: index === swingHighs.length - 1 ? 'high' : 'medium',
      description: `摆动高点 ${swing.price.toFixed(4)}`
    });
  });
  
  // 收集卖方流动性池（摆动低点）
  swingLows.slice(-5).forEach((swing, index) => {
    pools.sellSide.push({
      type: 'SWING_LOW',
      level: swing.price,
      index: swing.index,
      timestamp: swing.timestamp,
      priority: index === swingLows.length - 1 ? 'high' : 'medium',
      description: `摆动低点 ${swing.price.toFixed(4)}`
    });
  });
  
  // 识别等高点/等低点（多触点形成的流动性）
  const equalHighs = findEqualLevels(klines, 'high', 3);
  const equalLows = findEqualLevels(klines, 'low', 3);
  
  equalHighs.forEach(level => {
    pools.buySide.push({
      type: 'EQUAL_HIGH',
      level: level.price,
      touches: level.touches,
      priority: 'high',
      description: `等高点 ${level.price.toFixed(4)} (${level.touches}次触碰)`
    });
  });
  
  equalLows.forEach(level => {
    pools.sellSide.push({
      type: 'EQUAL_LOW',
      level: level.price,
      touches: level.touches,
      priority: 'high',
      description: `等低点 ${level.price.toFixed(4)} (${level.touches}次触碰)`
    });
  });
  
  return pools;
}

/**
 * 寻找等高点/等低点
 * @param {Array} klines - K线数据
 * @param {string} type - 'high' | 'low'
 * @param {number} tolerancePercent - 容差百分比
 * @returns {Array} 等水平位
 */
function findEqualLevels(klines, type, tolerancePercent = 0.3) {
  const levels = [];
  const recentKlines = klines.slice(-30);
  
  for (let i = 0; i < recentKlines.length; i++) {
    const price = type === 'high' ? recentKlines[i].high : recentKlines[i].low;
    let found = false;
    
    for (const level of levels) {
      const tolerance = level.price * (tolerancePercent / 100);
      if (Math.abs(price - level.price) < tolerance) {
        level.touches++;
        level.indices.push(i);
        found = true;
        break;
      }
    }
    
    if (!found) {
      levels.push({
        price,
        touches: 1,
        indices: [i]
      });
    }
  }
  
  // 返回触碰次数>=2的水平位
  return levels.filter(l => l.touches >= 2).sort((a, b) => b.touches - a.touches);
}

/**
 * 检测流动性扫荡
 * @param {Array} klines - K线数据
 * @param {Object} pools - 流动性池
 * @param {string} expectedDirection - 预期交易方向 'LONG' | 'SHORT'
 * @returns {Object} 扫荡检测结果
 */
function detectLiquiditySweep(klines, pools, expectedDirection) {
  const recentKlines = klines.slice(-SWEEP_CONFIG.VALIDITY_WINDOW);
  
  if (expectedDirection === 'LONG') {
    // 做多场景: 需要向下扫荡卖方流动性
    return detectSellSideSweep(recentKlines, pools.sellSide);
  } else if (expectedDirection === 'SHORT') {
    // 做空场景: 需要向上扫荡买方流动性
    return detectBuySideSweep(recentKlines, pools.buySide);
  }
  
  return { detected: false, reason: 'NO_DIRECTION' };
}

/**
 * 检测卖方流动性扫荡（做多场景）
 * @param {Array} klines - K线数据
 * @param {Array} sellSidePools - 卖方流动性池
 * @returns {Object} 扫荡结果
 */
function detectSellSideSweep(klines, sellSidePools) {
  if (!sellSidePools || sellSidePools.length === 0) {
    return { detected: false, reason: 'NO_LIQUIDITY_POOL' };
  }
  
  // 优先使用高优先级的流动性池
  const targetPool = sellSidePools.find(p => p.priority === 'high') || sellSidePools[0];
  
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const bodySize = Math.abs(k.close - k.open);
    const lowerWick = Math.min(k.open, k.close) - k.low;
    
    // 扫荡条件:
    // 1. 下引线刺破流动性池
    // 2. 下引线长度 > 实体长度 × WICK_RATIO
    // 3. 收盘价回收回流动性池上方
    
    const sweptLevel = k.low < targetPool.level;
    const wickCondition = bodySize > 0 && lowerWick > bodySize * SWEEP_CONFIG.WICK_RATIO;
    const reclaimCondition = k.close > targetPool.level;
    
    // 最小扫荡幅度检查
    const sweepSize = targetPool.level - k.low;
    const sweepPercent = (sweepSize / targetPool.level) * 100;
    const minSweepMet = sweepPercent >= SWEEP_CONFIG.MIN_SWEEP_PERCENT;
    
    if (sweptLevel && wickCondition && reclaimCondition && minSweepMet) {
      // 检查后续确认
      const confirmation = checkSweepConfirmation(klines, i, 'LONG');
      
      return {
        detected: true,
        type: 'SELL_SIDE_SWEEP',
        direction: 'LONG',
        pool: targetPool,
        sweepKline: {
          index: i,
          timestamp: k.timestamp,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close
        },
        sweepMetrics: {
          wickLength: lowerWick,
          bodySize: bodySize,
          wickToBodyRatio: lowerWick / bodySize,
          sweepDepth: sweepSize,
          sweepPercent: sweepPercent
        },
        confirmation,
        evidence: `下引线刺破${targetPool.description}后回收，引线/实体=${(lowerWick/bodySize).toFixed(2)}`
      };
    }
  }
  
  return { 
    detected: false, 
    reason: 'NO_VALID_SWEEP',
    targetPool: targetPool.level,
    checkedKlines: klines.length
  };
}

/**
 * 检测买方流动性扫荡（做空场景）
 * @param {Array} klines - K线数据
 * @param {Array} buySidePools - 买方流动性池
 * @returns {Object} 扫荡结果
 */
function detectBuySideSweep(klines, buySidePools) {
  if (!buySidePools || buySidePools.length === 0) {
    return { detected: false, reason: 'NO_LIQUIDITY_POOL' };
  }
  
  // 优先使用高优先级的流动性池
  const targetPool = buySidePools.find(p => p.priority === 'high') || buySidePools[0];
  
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const bodySize = Math.abs(k.close - k.open);
    const upperWick = k.high - Math.max(k.open, k.close);
    
    // 扫荡条件:
    // 1. 上引线刺破流动性池
    // 2. 上引线长度 > 实体长度 × WICK_RATIO
    // 3. 收盘价回收回流动性池下方
    
    const sweptLevel = k.high > targetPool.level;
    const wickCondition = bodySize > 0 && upperWick > bodySize * SWEEP_CONFIG.WICK_RATIO;
    const reclaimCondition = k.close < targetPool.level;
    
    // 最小扫荡幅度检查
    const sweepSize = k.high - targetPool.level;
    const sweepPercent = (sweepSize / targetPool.level) * 100;
    const minSweepMet = sweepPercent >= SWEEP_CONFIG.MIN_SWEEP_PERCENT;
    
    if (sweptLevel && wickCondition && reclaimCondition && minSweepMet) {
      // 检查后续确认
      const confirmation = checkSweepConfirmation(klines, i, 'SHORT');
      
      return {
        detected: true,
        type: 'BUY_SIDE_SWEEP',
        direction: 'SHORT',
        pool: targetPool,
        sweepKline: {
          index: i,
          timestamp: k.timestamp,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close
        },
        sweepMetrics: {
          wickLength: upperWick,
          bodySize: bodySize,
          wickToBodyRatio: upperWick / bodySize,
          sweepDepth: sweepSize,
          sweepPercent: sweepPercent
        },
        confirmation,
        evidence: `上引线刺破${targetPool.description}后回收，引线/实体=${(upperWick/bodySize).toFixed(2)}`
      };
    }
  }
  
  return { 
    detected: false, 
    reason: 'NO_VALID_SWEEP',
    targetPool: targetPool.level,
    checkedKlines: klines.length
  };
}

/**
 * 检查扫荡后的确认
 * @param {Array} klines - K线数据
 * @param {number} sweepIndex - 扫荡K线索引
 * @param {string} direction - 预期方向
 * @returns {Object} 确认结果
 */
function checkSweepConfirmation(klines, sweepIndex, direction) {
  if (sweepIndex >= klines.length - 1) {
    return { confirmed: false, reason: 'NO_SUBSEQUENT_CANDLE' };
  }
  
  const subsequentKlines = klines.slice(sweepIndex + 1);
  
  // 检查后续3根K线
  const checkWindow = Math.min(3, subsequentKlines.length);
  
  for (let i = 0; i < checkWindow; i++) {
    const k = subsequentKlines[i];
    
    if (direction === 'LONG') {
      // 做多确认: 后续K线收阳或继续上行
      if (k.close > k.open || (i > 0 && k.close > subsequentKlines[0].open)) {
        return {
          confirmed: true,
          confirmingKline: i,
          evidence: `扫荡后第${i + 1}根K线确认上行`
        };
      }
    } else if (direction === 'SHORT') {
      // 做空确认: 后续K线收阴或继续下行
      if (k.close < k.open || (i > 0 && k.close < subsequentKlines[0].open)) {
        return {
          confirmed: true,
          confirmingKline: i,
          evidence: `扫荡后第${i + 1}根K线确认下行`
        };
      }
    }
  }
  
  return { 
    confirmed: false, 
    reason: 'NO_CONFIRMATION_IN_WINDOW',
    checkedKlines: checkWindow
  };
}

/**
 * 流动性扫荡前置检查
 * 
 * 这是核心函数，用于信号生成前的扫荡确认
 * 
 * @param {Array} klines - K线数据（通常是MTF或LTF级别）
 * @param {string} direction - 预期交易方向
 * @param {Object} options - 配置选项
 * @returns {Object} 检查结果
 */
function requireLiquiditySweep(klines, direction, options = {}) {
  const config = { ...SWEEP_CONFIG, ...options };
  
  // 1. 识别流动性池
  const pools = identifyLiquidityPools(klines);
  
  // 2. 检测扫荡
  const sweepResult = detectLiquiditySweep(klines, pools, direction);
  
  // 3. 构建结果
  const result = {
    // 是否通过扫荡检查
    passed: sweepResult.detected,
    
    // 是否必须（可配置）
    required: config.CONFIRMATION_REQUIRED,
    
    // 检查结果详情
    check: {
      poolsIdentified: pools,
      sweepDetected: sweepResult.detected,
      sweepDetails: sweepResult.detected ? {
        type: sweepResult.type,
        pool: sweepResult.pool,
        metrics: sweepResult.sweepMetrics,
        confirmation: sweepResult.confirmation
      } : null,
      failureReason: sweepResult.detected ? null : sweepResult.reason
    },
    
    // 信号影响
    signalImpact: sweepResult.detected ? {
      action: 'ALLOW',
      ratingBoost: 10,  // 有扫荡确认时评分+10
      confidence: 'high'
    } : {
      action: config.CONFIRMATION_REQUIRED ? 'BLOCK' : 'DOWNGRADE',
      ratingPenalty: config.CONFIRMATION_REQUIRED ? 0 : 15,
      confidence: 'low',
      downgradeTo: 'C'
    },
    
    // 可观测字段（用于验收）
    observable: {
      liquidityPoolsCount: pools.buySide.length + pools.sellSide.length,
      sweepDetected: sweepResult.detected,
      sweepType: sweepResult.detected ? sweepResult.type : null,
      confirmationReceived: sweepResult.detected ? sweepResult.confirmation.confirmed : false
    }
  };
  
  return result;
}

/**
 * 等待流动性扫荡的工作流步骤
 * 
 * 这是完整的"等待-确认"工作流实现
 * 
 * @param {Object} params - 参数
 * @param {Array} params.mtfKlines - MTF K线数据
 * @param {Array} params.ltfKlines - LTF K线数据
 * @param {string} params.direction - 预期方向
 * @param {Object} params.htfPOI - HTF关键区域
 * @returns {Object} 工作流结果
 */
function waitForSweepWorkflow(params) {
  const { mtfKlines, ltfKlines, direction, htfPOI } = params;
  
  const workflow = {
    stage: 'WAITING_FOR_SWEEP',
    steps: [],
    completed: false,
    canProceed: false
  };
  
  // 步骤1: 检查价格是否在HTF POI内
  const currentPrice = mtfKlines[mtfKlines.length - 1].close;
  const inPOI = htfPOI.some(p => 
    (p.type === 'FVG' || p.type === 'ORDER_BLOCK') &&
    currentPrice >= p.bottom && currentPrice <= p.top
  );
  
  workflow.steps.push({
    name: 'CHECK_IN_HTF_POI',
    passed: inPOI,
    detail: inPOI ? '价格在HTF POI内' : '价格不在HTF POI内'
  });
  
  if (!inPOI) {
    workflow.canProceed = false;
    workflow.blockReason = 'PRICE_NOT_IN_HTF_POI';
    return workflow;
  }
  
  // 步骤2: 等待流动性扫荡
  const sweepCheck = requireLiquiditySweep(mtfKlines, direction);
  
  workflow.steps.push({
    name: 'WAIT_FOR_SWEEP',
    passed: sweepCheck.passed,
    detail: sweepCheck.passed 
      ? `检测到${sweepCheck.check.sweepDetails.type}` 
      : `未检测到有效扫荡: ${sweepCheck.check.failureReason}`
  });
  
  if (!sweepCheck.passed && sweepCheck.required) {
    workflow.canProceed = false;
    workflow.blockReason = 'LIQUIDITY_SWEEP_REQUIRED';
    workflow.missingConfirmation = 'LIQUIDITY_SWEEP';
    return workflow;
  }
  
  // 步骤3: 等待CHoCH/BOS确认
  const { detectChoCH, findSwingPoints } = require('./strategy');
  const { swingHighs, swingLows } = findSwingPoints(mtfKlines, 3);
  const choch = detectChoCH(mtfKlines, swingHighs, swingLows);
  
  workflow.steps.push({
    name: 'WAIT_FOR_CHOCH_BOS',
    passed: choch !== null,
    detail: choch 
      ? `检测到${choch.type}` 
      : '未检测到CHoCH'
  });
  
  if (!choch) {
    workflow.canProceed = false;
    workflow.blockReason = 'NO_CHOCH_CONFIRMATION';
    return workflow;
  }
  
  // 所有步骤通过
  workflow.completed = true;
  workflow.canProceed = true;
  workflow.sweepResult = sweepCheck;
  workflow.choch = choch;
  
  return workflow;
}

module.exports = {
  SWEEP_CONFIG,
  identifyLiquidityPools,
  findEqualLevels,
  detectLiquiditySweep,
  detectSellSideSweep,
  detectBuySideSweep,
  checkSweepConfirmation,
  requireLiquiditySweep,
  waitForSweepWorkflow
};
