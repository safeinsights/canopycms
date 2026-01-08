import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDebugLogger } from './debug'

describe('DebugLogger', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    // Save original env var
    originalEnv = process.env.CANOPYCMS_DEBUG
    // Mock console methods
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    // Restore env var
    if (originalEnv === undefined) {
      delete process.env.CANOPYCMS_DEBUG
    } else {
      process.env.CANOPYCMS_DEBUG = originalEnv
    }
    vi.restoreAllMocks()
  })

  it('respects enabled option', () => {
    const logger = createDebugLogger({ enabled: true })
    logger.debug('test', 'message')

    expect(console.log).toHaveBeenCalledOnce()
  })

  it('respects disabled option', () => {
    const logger = createDebugLogger({ enabled: false })
    logger.debug('test', 'message')

    expect(console.log).not.toHaveBeenCalled()
  })

  it('checks CANOPYCMS_DEBUG env var at call time, not construction time', () => {
    // Create logger before env var is set
    const logger = createDebugLogger()

    // Initially disabled
    logger.debug('test', 'message 1')
    expect(console.log).not.toHaveBeenCalled()

    // Enable via env var AFTER logger was created
    process.env.CANOPYCMS_DEBUG = 'true'

    // Should now be enabled
    logger.debug('test', 'message 2')
    expect(console.log).toHaveBeenCalledOnce()

    // Disable again
    process.env.CANOPYCMS_DEBUG = 'false'

    // Should be disabled
    logger.debug('test', 'message 3')
    expect(console.log).toHaveBeenCalledOnce() // Still only called once
  })

  it('explicit enabled option overrides env var', () => {
    process.env.CANOPYCMS_DEBUG = 'true'

    const logger = createDebugLogger({ enabled: false })
    logger.debug('test', 'message')

    expect(console.log).not.toHaveBeenCalled()
  })

  it('respects minLevel option', () => {
    const logger = createDebugLogger({ enabled: true, minLevel: 'WARN' })

    logger.debug('test', 'debug message')
    expect(console.log).not.toHaveBeenCalled()

    logger.info('test', 'info message')
    expect(console.log).not.toHaveBeenCalled()

    logger.warn('test', 'warn message')
    expect(console.warn).toHaveBeenCalledOnce()

    logger.error('test', 'error message')
    expect(console.error).toHaveBeenCalledOnce()
  })

  it('formats messages correctly', () => {
    const logger = createDebugLogger({ enabled: true, prefix: 'TestPrefix' })
    logger.debug('category', 'test message', { foo: 'bar' })

    const call = vi.mocked(console.log).mock.calls[0]
    expect(call[0]).toContain('[TestPrefix:category]')
    expect(call[0]).toContain('[DEBUG]')
    expect(call[0]).toContain('test message')
    expect(call[1]).toEqual({ foo: 'bar' })
  })

  it('throws on error when throwOnError is true', () => {
    const logger = createDebugLogger({ enabled: true, throwOnError: true })

    expect(() => {
      logger.error('test', 'error message')
    }).toThrow('error message')
  })

  it('does not throw on error when throwOnError is false', () => {
    const logger = createDebugLogger({ enabled: true, throwOnError: false })

    expect(() => {
      logger.error('test', 'error message')
    }).not.toThrow()
  })
})
