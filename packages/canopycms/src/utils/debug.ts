export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface DebugOptions {
  /** Enable/disable logging. Defaults to CANOPYCMS_DEBUG env var */
  enabled?: boolean
  /** Minimum log level to display. Defaults to DEBUG */
  minLevel?: LogLevel
  /** Prefix for all log messages. Defaults to 'CanopyCMS' */
  prefix?: string
  /** Throw an error when logger.error() is called. Defaults to false */
  throwOnError?: boolean
}

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

export class DebugLogger {
  private options: Required<DebugOptions>
  private timers: Map<string, number> = new Map()

  constructor(options: DebugOptions = {}) {
    this.options = {
      enabled: options.enabled ?? process.env.CANOPYCMS_DEBUG === 'true',
      minLevel: options.minLevel ?? 'DEBUG',
      prefix: options.prefix ?? 'CanopyCMS',
      throwOnError: options.throwOnError ?? false,
    }
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.options.enabled) return false
    return LOG_LEVELS[level] >= LOG_LEVELS[this.options.minLevel]
  }

  private formatMessage(level: LogLevel, category: string, message: string): string {
    const timestamp = new Date().toISOString()
    return `[${timestamp}] [${this.options.prefix}:${category}] [${level}] ${message}`
  }

  debug(category: string, message: string, data?: any) {
    if (this.shouldLog('DEBUG')) {
      console.log(this.formatMessage('DEBUG', category, message), data ?? '')
    }
  }

  info(category: string, message: string, data?: any) {
    if (this.shouldLog('INFO')) {
      console.log(this.formatMessage('INFO', category, message), data ?? '')
    }
  }

  warn(category: string, message: string, data?: any) {
    if (this.shouldLog('WARN')) {
      console.warn(this.formatMessage('WARN', category, message), data ?? '')
    }
  }

  error(category: string, message: string, data?: any) {
    const msg = this.formatMessage('ERROR', category, message)

    if (this.shouldLog('ERROR')) {
      console.error(msg, data ?? '')
    }

    if (this.options.throwOnError) {
      const errorMsg = data ? `${message}: ${JSON.stringify(data)}` : message
      throw new Error(errorMsg)
    }
  }

  /**
   * Start timing an operation
   */
  time(label: string) {
    this.timers.set(label, Date.now())
  }

  /**
   * End timing an operation and log the duration
   */
  timeEnd(category: string, label: string) {
    const start = this.timers.get(label)
    if (start === undefined) {
      this.warn(category, `Timer '${label}' does not exist`)
      return
    }

    const duration = Date.now() - start
    this.timers.delete(label)
    this.debug(category, `${label} completed`, { durationMs: duration })
    return duration
  }

  /**
   * Wrap an async function with automatic timing
   */
  async timed<T>(category: string, label: string, fn: () => Promise<T>): Promise<T> {
    this.time(label)
    try {
      return await fn()
    } finally {
      this.timeEnd(category, label)
    }
  }
}

/**
 * Create a debug logger instance
 */
export function createDebugLogger(options?: DebugOptions): DebugLogger {
  return new DebugLogger(options)
}

/**
 * Default logger for test infrastructure (E2E tests)
 * Enabled via E2E_DEBUG=true
 */
export const testLogger = createDebugLogger({
  enabled: process.env.E2E_DEBUG === 'true',
  prefix: 'E2E',
  throwOnError: false,
})
