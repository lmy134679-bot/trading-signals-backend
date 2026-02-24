// 错误处理与边界条件检查

// 自定义错误类
class AppError extends Error {
  constructor(message, code, statusCode = 500, metadata = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.metadata = metadata;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
        timestamp: this.timestamp,
        ...this.metadata
      }
    };
  }
}

// 业务错误
class BusinessError extends AppError {
  constructor(message, code, metadata = {}) {
    super(message, code, 400, metadata);
    this.name = 'BusinessError';
  }
}

// 验证错误
class ValidationError extends AppError {
  constructor(message, field, metadata = {}) {
    super(message, 'VALIDATION_ERROR', 400, { field, ...metadata });
    this.name = 'ValidationError';
  }
}

// 外部服务错误
class ExternalServiceError extends AppError {
  constructor(message, service, metadata = {}) {
    super(message, 'EXTERNAL_SERVICE_ERROR', 502, { service, ...metadata });
    this.name = 'ExternalServiceError';
  }
}

// 超时错误
class TimeoutError extends AppError {
  constructor(message, operation, timeoutMs, metadata = {}) {
    super(message, 'TIMEOUT_ERROR', 504, { operation, timeoutMs, ...metadata });
    this.name = 'TimeoutError';
  }
}

// 限流错误
class RateLimitError extends AppError {
  constructor(message, limit, window, metadata = {}) {
    super(message, 'RATE_LIMIT_ERROR', 429, { limit, window, ...metadata });
    this.name = 'RateLimitError';
  }
}

// 输入验证器
class InputValidator {
  // 验证symbol格式
  static validateSymbol(symbol) {
    if (!symbol) {
      throw new ValidationError('Symbol is required', 'symbol');
    }
    if (typeof symbol !== 'string') {
      throw new ValidationError('Symbol must be a string', 'symbol');
    }
    if (symbol.length > 50) {
      throw new ValidationError('Symbol too long (max 50 chars)', 'symbol');
    }
    // 只允许字母、数字、下划线
    if (!/^[A-Za-z0-9_]+$/.test(symbol)) {
      throw new ValidationError('Symbol contains invalid characters', 'symbol');
    }
    return true;
  }

  // 验证K线数据
  static validateKlines(klines) {
    if (!Array.isArray(klines)) {
      throw new ValidationError('Klines must be an array', 'klines');
    }
    if (klines.length === 0) {
      throw new ValidationError('Klines array is empty', 'klines');
    }
    if (klines.length < 20) {
      throw new ValidationError('Klines must have at least 20 data points', 'klines');
    }

    // 验证每条K线
    const requiredFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
    for (let i = 0; i < klines.length; i++) {
      const kline = klines[i];
      for (const field of requiredFields) {
        if (!(field in kline)) {
          throw new ValidationError(
            `Kline[${i}] missing required field: ${field}`,
            `klines[${i}].${field}`
          );
        }
      }

      // 验证数值范围
      if (kline.high < kline.low) {
        throw new ValidationError(
          `Kline[${i}] high (${kline.high}) < low (${kline.low})`,
          `klines[${i}]`
        );
      }
      if (kline.open < 0 || kline.high < 0 || kline.low < 0 || kline.close < 0) {
        throw new ValidationError(
          `Kline[${i}] contains negative price`,
          `klines[${i}]`
        );
      }
      if (kline.volume < 0) {
        throw new ValidationError(
          `Kline[${i}] contains negative volume`,
          `klines[${i}].volume`
        );
      }
    }

    return true;
  }

  // 验证时间戳
  static validateTimestamp(timestamp) {
    if (!timestamp) {
      throw new ValidationError('Timestamp is required', 'timestamp');
    }
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      throw new ValidationError('Invalid timestamp format', 'timestamp');
    }
    // 检查时间是否在合理范围内（过去1年到未来1小时）
    const now = Date.now();
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
    const oneHourLater = now + 60 * 60 * 1000;
    if (date.getTime() < oneYearAgo || date.getTime() > oneHourLater) {
      throw new ValidationError('Timestamp out of valid range', 'timestamp');
    }
    return true;
  }

  // 验证评分
  static validateScore(score) {
    if (typeof score !== 'number') {
      throw new ValidationError('Score must be a number', 'score');
    }
    if (score < 0 || score > 100) {
      throw new ValidationError('Score must be between 0 and 100', 'score');
    }
    return true;
  }

  // 验证价格
  static validatePrice(price, fieldName = 'price') {
    if (typeof price !== 'number') {
      throw new ValidationError(`${fieldName} must be a number`, fieldName);
    }
    if (price <= 0) {
      throw new ValidationError(`${fieldName} must be positive`, fieldName);
    }
    if (!isFinite(price)) {
      throw new ValidationError(`${fieldName} must be finite`, fieldName);
    }
    return true;
  }
}

// 重试工具
async function withRetry(operation, options = {}) {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    backoffMultiplier = 2,
    timeout = 30000,
    onRetry = null,
    shouldRetry = (error) => true
  } = options;

  let lastError;
  let delay = retryDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 使用Promise.race实现超时
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new TimeoutError(
            'Operation timeout',
            'retry_operation',
            timeout
          )), timeout)
        )
      ]);
      return result;
    } catch (error) {
      lastError = error;

      // 判断是否应该重试
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // 回调通知
      if (onRetry) {
        onRetry(attempt + 1, maxRetries, error);
      }

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= backoffMultiplier;
    }
  }

  throw lastError;
}

// 限流器
class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60 * 60 * 1000; // 默认1小时
    this.maxRequests = options.maxRequests || 100;
    this.requests = new Map();
  }

  // 获取key的当前请求数
  getRequestCount(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }

    const timestamps = this.requests.get(key);
    // 清理过期的请求记录
    const validRequests = timestamps.filter(t => t > windowStart);
    this.requests.set(key, validRequests);

    return validRequests.length;
  }

  // 检查是否允许请求
  allowRequest(key) {
    const count = this.getRequestCount(key);
    return count < this.maxRequests;
  }

  // 记录请求
  recordRequest(key) {
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }
    this.requests.get(key).push(Date.now());
  }

  // 检查并记录（原子操作）
  checkAndRecord(key) {
    if (!this.allowRequest(key)) {
      const count = this.getRequestCount(key);
      throw new RateLimitError(
        `Rate limit exceeded: ${count}/${this.maxRequests} requests per ${this.windowMs / 60000} minutes`,
        this.maxRequests,
        this.windowMs
      );
    }
    this.recordRequest(key);
  }

  // 获取剩余额度
  getRemaining(key) {
    const count = this.getRequestCount(key);
    return Math.max(0, this.maxRequests - count);
  }

  // 重置
  reset(key) {
    if (key) {
      this.requests.delete(key);
    } else {
      this.requests.clear();
    }
  }
}

// 幂等性检查器
class IdempotencyChecker {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 4 * 60 * 60 * 1000; // 默认4小时
    this.processedKeys = new Map();
  }

  // 生成幂等key
  generateKey(...components) {
    return components.join('_');
  }

  // 检查是否已处理
  isProcessed(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    if (!this.processedKeys.has(key)) {
      return false;
    }

    const timestamp = this.processedKeys.get(key);
    if (timestamp < windowStart) {
      // 过期，删除
      this.processedKeys.delete(key);
      return false;
    }

    return true;
  }

  // 标记为已处理
  markProcessed(key) {
    this.processedKeys.set(key, Date.now());
  }

  // 检查并标记（原子操作）
  checkAndMark(key) {
    if (this.isProcessed(key)) {
      return { processed: true, firstTime: false };
    }
    this.markProcessed(key);
    return { processed: false, firstTime: true };
  }

  // 清理过期记录
  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [key, timestamp] of this.processedKeys) {
      if (timestamp < windowStart) {
        this.processedKeys.delete(key);
      }
    }
  }
}

// 敏感信息脱敏
function sanitizeSensitiveData(data) {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  const sensitiveFields = [
    'apiKey', 'api_key', 'secret', 'password', 'token',
    'privateKey', 'private_key', 'seed', 'mnemonic'
  ];

  const sanitized = Array.isArray(data) ? [...data] : { ...data };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
      sanitized[key] = '***';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeSensitiveData(sanitized[key]);
    }
  }

  return sanitized;
}

module.exports = {
  AppError,
  BusinessError,
  ValidationError,
  ExternalServiceError,
  TimeoutError,
  RateLimitError,
  InputValidator,
  withRetry,
  RateLimiter,
  IdempotencyChecker,
  sanitizeSensitiveData
};
