/**
 * Unit tests for the process-scoped logger indirection.
 *
 * The property that actually matters operationally is the LAST one here:
 * `canopyLog*` must resolve the active logger at CALL time. A module like
 * github-service.ts is imported long before a worker entrypoint runs
 * `installWorkerLogger()`, so an implementation that captured the logger at
 * import time would leave exactly the modules this exists for still writing
 * unprefixed lines - the original bug, reintroduced and invisible.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canopyLog,
  canopyLogError,
  canopyLogWarn,
  getCanopyLogger,
  resetCanopyLogger,
  setCanopyLogger,
  type CanopyLogger,
} from './logger'

const makeRecorder = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
})

afterEach(() => {
  resetCanopyLogger()
  vi.restoreAllMocks()
})

describe('canopy logger indirection', () => {
  it('defaults to console, so nothing changes for Lambda and the dev server', () => {
    // mockImplementation, not a bare spy: a real write would trip vitest's
    // console interceptor and fail the run.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    canopyLogWarn('hello')

    expect(warn).toHaveBeenCalledWith('hello')
    expect(getCanopyLogger()).toBe(console)
  })

  it('routes each level to the installed logger', () => {
    const recorder = makeRecorder()
    setCanopyLogger(recorder)

    canopyLog('info line')
    canopyLogWarn('warn line')
    canopyLogError('error line', { taskId: 'abc' })

    expect(recorder.log).toHaveBeenCalledWith('info line')
    expect(recorder.warn).toHaveBeenCalledWith('warn line')
    expect(recorder.error).toHaveBeenCalledWith('error line', { taskId: 'abc' })
  })

  it('passes every argument through untouched, so console keeps formatting Errors and objects', () => {
    const recorder = makeRecorder()
    setCanopyLogger(recorder)
    const err = new Error('kaboom')

    canopyLogError('Task failed:', err, { taskId: 'abc' })

    expect(recorder.error).toHaveBeenCalledWith('Task failed:', err, { taskId: 'abc' })
  })

  it('restores console on reset', () => {
    setCanopyLogger(makeRecorder())
    resetCanopyLogger()

    expect(getCanopyLogger()).toBe(console)
  })

  it('resolves the logger at CALL time, not at import time', () => {
    // Simulates the real sequence: a shared module captures a reference to the
    // helper (as `import { canopyLogWarn }` does) BEFORE the worker entrypoint
    // installs anything, then logs afterwards.
    const capturedHelper = canopyLogWarn
    const recorder = makeRecorder()

    setCanopyLogger(recorder)
    capturedHelper('emitted after install')

    expect(recorder.warn).toHaveBeenCalledWith('emitted after install')
  })

  it('lets a later install replace an earlier one', () => {
    const first = makeRecorder()
    const second = makeRecorder()

    setCanopyLogger(first)
    setCanopyLogger(second)
    canopyLogWarn('only the second should see this')

    expect(first.warn).not.toHaveBeenCalled()
    expect(second.warn).toHaveBeenCalledWith('only the second should see this')
  })

  it('accepts console itself as a CanopyLogger (structural compatibility)', () => {
    // Guards the type contract: `let active: CanopyLogger = console` in the
    // module only compiles while console structurally satisfies the interface.
    const asLogger: CanopyLogger = console
    expect(typeof asLogger.warn).toBe('function')
  })
})
