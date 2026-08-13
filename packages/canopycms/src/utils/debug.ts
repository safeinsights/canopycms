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
  private options: DebugOptions
  private timers: Map<string, number> = new Map()

  constructor(options: DebugOptions = {}) {
    this.options = options
  }

  private shouldLog(level: LogLevel): boolean {
    // Check enabled at call time to support runtime env var changes
    const enabled = this.options.enabled ?? process.env.CANOPYCMS_DEBUG === 'true'
    if (!enabled) return false

    const minLevel = this.options.minLevel ?? 'DEBUG'
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel]
  }

  /**
   * The ISO-8601 timestamp leads the line BARE - not wrapped in brackets as it
   * once was. `CANOPYCMS_DEBUG=true` can be set on the EC2 worker, whose stdout
   * appends to /var/log/canopy-worker/worker.log; the CloudWatch agent's
   * `multi_line_start_pattern` matches the timestamp at the START of a line
   * (see worker/log.ts's INVARIANT and cms-service.ts's agent config), so a
   * leading `[` meant every debug line was silently folded into the previous
   * event instead of starting its own. The bracketed `[prefix:category]` and
   * `[level]` fields still follow, so the human-readable shape is unchanged
   * apart from those two characters.
   */
  private formatMessage(level: LogLevel, category: string, message: string): string {
    const timestamp = new Date().toISOString()
    const prefix = this.options.prefix ?? 'CanopyCMS'
    return `${timestamp} [${prefix}:${category}] [${level}] ${message}`
  }

  debug(category: string, message: string, data?: unknown) {
    if (this.shouldLog('DEBUG')) {
      console.log(this.formatMessage('DEBUG', category, message), data ?? '')
    }
  }

  info(category: string, message: string, data?: unknown) {
    if (this.shouldLog('INFO')) {
      console.log(this.formatMessage('INFO', category, message), data ?? '')
    }
  }

  warn(category: string, message: string, data?: unknown) {
    if (this.shouldLog('WARN')) {
      console.warn(this.formatMessage('WARN', category, message), data ?? '')
    }
  }

  error(category: string, message: string, data?: unknown) {
    const msg = this.formatMessage('ERROR', category, message)

    if (this.shouldLog('ERROR')) {
      console.error(msg, data ?? '')
    }

    const throwOnError = this.options.throwOnError ?? false
    if (throwOnError) {
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
