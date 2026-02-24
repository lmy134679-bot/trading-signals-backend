/**
 * Gate.io API 数据获取模块
 * 支持多时间框架数据获取
 */

const axios = require('axios');

// Gate.io API 基础配置
const GATEIO_API_BASE = 'https://api.gateio.ws/api/v4';

// 54个交易对
const SYMBOLS_54 = [
  'BTC_USDT', 'ETH_USDT', 'BNB_USDT', 'SOL_USDT', 'XRP_USDT',
  'ADA_USDT', 'AVAX_USDT', 'DOT_USDT', 'MATIC_USDT', 'LINK_USDT',
  'UNI_USDT', 'LTC_USDT', 'NEAR_USDT', 'APT_USDT', 'ATOM_USDT',
  'ETC_USDT', 'XLM_USDT', 'FIL_USDT', 'ARB_USDT', 'OP_USDT',
  'SUI_USDT', 'SEI_USDT', 'TIA_USDT', 'STRK_USDT', 'PYTH_USDT',
  'JUP_USDT', 'WIF_USDT', 'BONK_USDT', 'PEPE_USDT', 'SHIB_USDT',
  'DOGE_USDT', 'FLOKI_USDT', 'MEME_USDT', 'ORDI_USDT', 'SATS_USDT',
  'RATS_USDT', 'CAT_USDT', 'AI_USDT', 'XAI_USDT', 'NFP_USDT',
  'MANTA_USDT', 'DYM_USDT', 'PIXEL_USDT', 'PORTAL_USDT', 'AEVO_USDT',
  'WLD_USDT', 'ARKM_USDT', 'TAO_USDT', 'FET_USDT', 'RNDR_USDT',
  'AGIX_USDT', 'IMX_USDT', 'GRT_USDT', 'LDO_USDT'
];

// 时间框架配置
const TIMEFRAME_CONFIG = {
  '1m': { interval: '1m', limit: 200, msPerCandle: 60 * 1000 },
  '5m': { interval: '5m', limit: 200, msPerCandle: 5 * 60 * 1000 },
  '15m': { interval: '15m', limit: 200, msPerCandle: 15 * 60 * 1000 },
  '1h': { interval: '1h', limit: 100, msPerCandle: 60 * 60 * 1000 },
  '4h': { interval: '4h', limit: 100, msPerCandle: 4 * 60 * 60 * 1000 },
  '1d': { interval: '1d', limit: 50, msPerCandle: 24 * 60 * 60 * 1000 }
};

/**
 * 获取单个交易对的K线数据
 * @param {string} symbol - 交易对，如 BTC_USDT
 * @param {string} timeframe - 时间框架，如 4h, 15m, 1m
 * @param {number} limit - 获取条数
 * @returns {Promise<Array>} K线数据数组
 */
async function getKlines(symbol, timeframe = '4h', limit = 100) {
  try {
    const config = TIMEFRAME_CONFIG[timeframe];
    if (!config) {
      throw new Error(`Unsupported timeframe: ${timeframe}`);
    }

    const currencyPair = symbol.replace('_', '_');
    const url = `${GATEIO_API_BASE}/spot/candlesticks`;
    
    const response = await axios.get(url, {
      params: {
        currency_pair: currencyPair,
        interval: config.interval,
        limit: limit || config.limit
      },
      timeout: 10000
    });

    if (!response.data || !Array.isArray(response.data)) {
      return null;
    }

    // Gate.io返回格式: [timestamp, volume, close, high, low, open]
    return response.data.map(candle => ({
      timestamp: parseInt(candle[0]) * 1000,
      volume: parseFloat(candle[1]),
      close: parseFloat(candle[2]),
      high: parseFloat(candle[3]),
      low: parseFloat(candle[4]),
      open: parseFloat(candle[5])
    }));
  } catch (error) {
    console.error(`Error fetching klines for ${symbol} (${timeframe}):`, error.message);
    return null;
  }
}

/**
 * 批量获取所有交易对的K线数据
 * @param {string} timeframe - 时间框架
 * @param {number} limit - 获取条数
 * @returns {Promise<Object>} 以symbol为键的K线数据对象
 */
async function getAllKlines(timeframe = '4h', limit = 100) {
  const results = {};
  const errors = [];

  // 分批获取，避免并发过高
  const batchSize = 5;
  for (let i = 0; i < SYMBOLS_54.length; i += batchSize) {
    const batch = SYMBOLS_54.slice(i, i + batchSize);
    
    const promises = batch.map(async (symbol) => {
      try {
        const klines = await getKlines(symbol, timeframe, limit);
        if (klines && klines.length > 0) {
          results[symbol] = klines;
        }
      } catch (error) {
        errors.push({ symbol, error: error.message });
      }
    });

    await Promise.all(promises);
    
    // 批次间延迟，避免限流
    if (i + batchSize < SYMBOLS_54.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  if (errors.length > 0) {
    console.warn(`Klines fetch errors (${errors.length}):`, errors.slice(0, 3));
  }

  return results;
}

/**
 * 获取多时间框架数据（用于MTF分析）
 * @param {string} symbol - 交易对
 * @param {Array<string>} timeframes - 时间框架数组，如 ['4h', '15m', '1m']
 * @returns {Promise<Object>} 各时间框架的K线数据
 */
async function getMultiTimeframeKlines(symbol, timeframes = ['4h', '15m', '1m']) {
  const results = {};
  
  for (const tf of timeframes) {
    try {
      const klines = await getKlines(symbol, tf, TIMEFRAME_CONFIG[tf].limit);
      if (klines) {
        results[tf] = klines;
      }
    } catch (error) {
      console.error(`Error fetching ${tf} klines for ${symbol}:`, error.message);
    }
  }
  
  return results;
}

/**
 * 获取所有交易对的多时间框架数据
 * @param {Array<string>} timeframes - 时间框架数组
 * @returns {Promise<Object>} 以symbol为键的多时间框架数据
 */
async function getAllMultiTimeframeKlines(timeframes = ['4h', '15m', '1m']) {
  const results = {};
  
  for (const symbol of SYMBOLS_54) {
    try {
      const mtfData = await getMultiTimeframeKlines(symbol, timeframes);
      if (Object.keys(mtfData).length === timeframes.length) {
        results[symbol] = mtfData;
      }
    } catch (error) {
      console.error(`Error fetching MTF data for ${symbol}:`, error.message);
    }
    
    // 延迟避免限流
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

/**
 * 获取实时价格（ticker）
 * @returns {Promise<Object>} 以symbol为键的ticker数据
 */
async function getTickers() {
  try {
    const url = `${GATEIO_API_BASE}/spot/tickers`;
    const response = await axios.get(url, { timeout: 10000 });

    if (!response.data || !Array.isArray(response.data)) {
      return null;
    }

    const tickers = {};
    response.data.forEach(ticker => {
      const symbol = ticker.currency_pair;
      if (SYMBOLS_54.includes(symbol)) {
        tickers[symbol] = {
          symbol,
          last: parseFloat(ticker.last),
          high24h: parseFloat(ticker.high_24h),
          low24h: parseFloat(ticker.low_24h),
          volume24h: parseFloat(ticker.base_volume),
          quoteVolume24h: parseFloat(ticker.quote_volume),
          change24h: parseFloat(ticker.change_percentage),
          bid: parseFloat(ticker.highest_bid),
          ask: parseFloat(ticker.lowest_ask)
        };
      }
    });

    return tickers;
  } catch (error) {
    console.error('Error fetching tickers:', error.message);
    return null;
  }
}

/**
 * 获取单个交易对实时价格
 * @param {string} symbol - 交易对
 * @returns {Promise<Object>} ticker数据
 */
async function getTicker(symbol) {
  try {
    const currencyPair = symbol.replace('_', '_');
    const url = `${GATEIO_API_BASE}/spot/tickers`;
    const response = await axios.get(url, {
      params: { currency_pair: currencyPair },
      timeout: 5000
    });

    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
      return null;
    }

    const ticker = response.data[0];
    return {
      symbol,
      last: parseFloat(ticker.last),
      high24h: parseFloat(ticker.high_24h),
      low24h: parseFloat(ticker.low_24h),
      volume24h: parseFloat(ticker.base_volume),
      change24h: parseFloat(ticker.change_percentage)
    };
  } catch (error) {
    console.error(`Error fetching ticker for ${symbol}:`, error.message);
    return null;
  }
}

module.exports = {
  SYMBOLS_54,
  TIMEFRAME_CONFIG,
  getKlines,
  getAllKlines,
  getMultiTimeframeKlines,
  getAllMultiTimeframeKlines,
  getTickers,
  getTicker
};
