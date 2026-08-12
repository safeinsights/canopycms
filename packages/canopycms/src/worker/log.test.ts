/**
 * Unit tests for the worker's timestamp-prefixing log helpers.
 *
 * These assert the on-the-wire shape of a worker log line, not just that
 * something got logged: the CloudWatch agent config in
 * packages/canopycms-cdk/src/constructs/cms-service.ts parses that prefix with
 * `"timestamp_format": "%Y-%m-%dT%H:%M:%S.%f"` and reuses it as
 * `multi_line_start_pattern`. If the prefix shape drifts, CloudWatch silently
 * falls back to ingestion timestamps and stack traces start fragmenting again
 * - a failure nothing else in the suite would catch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { workerLog, workerLogWarn, workerLogError } from './log'

/** `2026-08-12T14:30:00.000Z` - ISO-8601, millisecond precision, UTC. */
const ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * mockImplementation (not a bare spy) so the line never reaches Vitest's
 * console interceptor, which fails the run in CI on stray output.
 */
function spyOn(method: 'log' | 'warn' | 'error') {
  return vi.spyOn(console, method).mockImplementation(() => {})
}

describe('worker log helpers', () => {
  it('prefixes stdout output with an ISO-8601 timestamp and an INFO level tag', () => {
    const spy = spyOn('log')

    workerLog('Pushed my-branch to GitHub')

    expect(spy).toHaveBeenCalledTimes(1)
    const [stamp, level, message] = spy.mock.calls[0]
    expect(stamp).toMatch(ISO_8601_MS)
    expect(level).toBe('INFO')
    expect(message).toBe('Pushed my-branch to GitHub')
  })

  it('routes warnings to console.warn with a WARN tag', () => {
    const spy = spyOn('warn')

    workerLogWarn('Failed to poll PR #12')

    const [stamp, level, message] = spy.mock.calls[0]
    expect(stamp).toMatch(ISO_8601_MS)
    expect(level).toBe('WARN')
    expect(message).toBe('Failed to poll PR #12')
  })

  it('routes errors to console.error with an ERROR tag', () => {
    const spy = spyOn('error')

    workerLogError('Worker loop error:', 'boom')

    const [stamp, level, ...rest] = spy.mock.calls[0]
    expect(stamp).toMatch(ISO_8601_MS)
    expect(level).toBe('ERROR')
    expect(rest).toEqual(['Worker loop error:', 'boom'])
  })

  it('passes non-string arguments through untouched so console can format them', () => {
    // The prefix is passed as a separate argument rather than concatenated
    // into the message precisely so this holds: an Error reaching console.error
    // still prints with its stack, and objects still get inspected.
    const spy = spyOn('error')
    const err = new Error('kaboom')

    workerLogError('Task failed:', err, { taskId: 'abc' })

    const [, , label, passedErr, passedObj] = spy.mock.calls[0]
    expect(label).toBe('Task failed:')
    expect(passedErr).toBe(err)
    expect(passedObj).toEqual({ taskId: 'abc' })
  })

  it('emits a parseable timestamp for the current time', () => {
    const spy = spyOn('log')
    const before = Date.now()

    workerLog('tick')

    const after = Date.now()
    const parsed = Date.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toBeGreaterThanOrEqual(before)
    expect(parsed).toBeLessThanOrEqual(after)
  })
})
