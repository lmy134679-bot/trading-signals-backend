// 结构化日志工具 - 支持追踪和可观测性

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';

class Logger {
  constructor(serviceName = 'signal-agent') {
    this.serviceName = serviceName;
  }

  // 生成trace_id
  generateTraceId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // 生成span_id
  generateSpanId() {
    return `span-${Math.random().toString(36).substr(2, 6)}`;
  }

  // 格式化日志
  formatLog(level, message, metadata = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      ...metadata
    };

    // 添加trace_id和span_id（如果存在）
    if (metadata.trace_id) {
      logEntry.trace_id = metadata.trace_id;
    }
    if (metadata.span_id) {
      logEntry.span_id = metadata.span_id;
    }

    return logEntry;
  }

  // 检查日志级别
  shouldLog(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[CURRENT_LOG_LEVEL];
  }

  debug(message, metadata = {}) {
    if (this.shouldLog('DEBUG')) {
      console.log(JSON.stringify(this.formatLog('DEBUG', message, metadata)));
    }
  }

  info(message, metadata = {}) {
    if (this.shouldLog('INFO')) {
      console.log(JSON.stringify(this.formatLog('INFO', message, metadata)));
    }
  }

  warn(message, metadata = {}) {
    if (this.shouldLog('WARN')) {
      console.warn(JSON.stringify(this.formatLog('WARN', message, metadata)));
    }
  }

  error(message, metadata = {}) {
    if (this.shouldLog('ERROR')) {
      console.error(JSON.stringify(this.formatLog('ERROR', message, metadata)));
    }
  }

  // 记录操作开始
  startOperation(operation, metadata = {}) {
    const traceId = metadata.trace_id || this.generateTraceId();
    const spanId = this.generateSpanId();
    const startTime = Date.now();

    this.info(`Starting ${operation}`, {
      trace_id: traceId,
      span_id: spanId,
      operation,
      ...metadata
    });

    return {
      traceId,
      spanId,
      startTime,
      end: (status = 'success', resultMetadata = {}) => {
        const duration = Date.now() - startTime;
        this.info(`Completed ${operation}`, {
          trace_id: traceId,
          span_id: spanId,
          operation,
          duration_ms: duration,
          status,
          ...resultMetadata
        });
        return { traceId, spanId, duration, status };
      }
    };
  }
}

// 指标收集器
class MetricsCollector {
  constructor() {
    this.metrics = new Map();
    this.histograms = new Map();
  }

  // 计数器
  increment(name, labels = {}, value = 1) {
    const key = this.getKey(name, labels);
    const current = this.metrics.get(key) || 0;
    this.metrics.set(key, current + value);
  }

  // 直方图
  observe(name, value, labels = {}) {
    const key = this.getKey(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    this.histograms.get(key).push(value);
  }

  // 设置Gauge
  gauge(name, value, labels = {}) {
    const key = this.getKey(name, labels);
    this.metrics.set(key, value);
  }

  // 获取指标key
  getKey(name, labels) {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  // 获取所有指标
  getAll() {
    const result = {};
    for (const [key, value] of this.metrics) {
      result[key] = value;
    }
    return result;
  }

  // 获取直方图统计
  getHistogramStats(name, labels = {}) {
    const key = this.getKey(name, labels);
    const values = this.histograms.get(key) || [];
    if (values.length === 0) return null;

    const sorted = values.sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const count = sorted.length;

    return {
      count,
      sum,
      avg: sum / count,
      min: sorted[0],
      max: sorted[count - 1],
      p50: sorted[Math.floor(count * 0.5)],
      p95: sorted[Math.floor(count * 0.95)],
      p99: sorted[Math.floor(count * 0.99)]
    };
  }

  // Prometheus格式导出
  toPrometheus() {
    const lines = [];

    // 计数器和Gauge
    for (const [key, value] of this.metrics) {
      lines.push(`# TYPE ${key.split('{')[0]} gauge`);
      lines.push(`${key} ${value}`);
    }

    // 直方图
    for (const [key, values] of this.histograms) {
      const name = key.split('{')[0];
      const sorted = values.sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);

      lines.push(`# TYPE ${name} histogram`);
      lines.push(`${key}_count ${sorted.length}`);
      lines.push(`${key}_sum ${sum}`);
    }

    return lines.join('\n');
  }
}

// 创建全局实例
const logger = new Logger();
const metrics = new MetricsCollector();

module.exports = { Logger, MetricsCollector, logger, metrics };
