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

import { workerLog, workerLogWarn, workerLogError, installWorkerLogger } from './log'
import { canopyLog, canopyLogWarn, canopyLogError, resetCanopyLogger } from '../utils/logger'
import { createOrUpdatePullRequest } from '../github-service'
import type { Octokit } from '@octokit/rest'

/** `2026-08-12T14:30:00.000Z` - ISO-8601, millisecond precision, UTC. */
const ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

afterEach(() => {
  // The logger is process-scoped module state, so a test that installs the
  // worker logger would otherwise leak the prefix into every later test in
  // this worker.
  resetCanopyLogger()
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

describe('installWorkerLogger', () => {
  it('is NOT applied by merely importing this module', () => {
    // Deliberately not a module-level side effect: a Lambda or dev-server
    // process that imports anything re-exporting worker/log.ts must keep plain
    // console, where CloudWatch delimits events itself.
    const spy = spyOn('warn')

    canopyLogWarn('unprefixed by default')

    expect(spy).toHaveBeenCalledWith('unprefixed by default')
  })

  it('routes every canopyLog* level through the prefixing helpers once installed', () => {
    const log = spyOn('log')
    const warn = spyOn('warn')
    const error = spyOn('error')

    installWorkerLogger()
    canopyLog('info line')
    canopyLogWarn('warn line')
    canopyLogError('error line')

    for (const [spy, level, message] of [
      [log, 'INFO', 'info line'],
      [warn, 'WARN', 'warn line'],
      [error, 'ERROR', 'error line'],
    ] as const) {
      const [stamp, emittedLevel, emittedMessage] = spy.mock.calls[0]
      expect(stamp).toMatch(ISO_8601_MS)
      expect(emittedLevel).toBe(level)
      expect(emittedMessage).toBe(message)
    }
  })

  it('prefixes a warning emitted from a shared module the worker executes', async () => {
    // The end-to-end shape of the finding, driven through a REAL production
    // call path rather than the helper in isolation: github-service.ts is not
    // in a worker directory, but createOrUpdatePullRequest runs as a worker
    // task, and its GIT-M5 multi-PR warning used to reach worker.log with no
    // timestamp - so the CloudWatch agent appended it to whatever event came
    // before, inheriting that timestamp and dropping the WARN tag.
    const warn = spyOn('warn')
    installWorkerLogger()

    const octokit = {
      pulls: {
        list: vi.fn().mockResolvedValue({
          data: [
            { number: 5, html_url: 'https://example.test/5', updated_at: '2026-01-01T00:00:00Z' },
            { number: 9, html_url: 'https://example.test/9', updated_at: '2026-02-01T00:00:00Z' },
          ],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as Octokit

    await createOrUpdatePullRequest({
      octokit,
      owner: 'test-owner',
      repo: 'test-repo',
      head: 'feature-branch',
      base: 'main',
      title: 'Submit feature-branch',
      body: 'Body',
    })

    expect(warn).toHaveBeenCalledTimes(1)
    const [stamp, level, message] = warn.mock.calls[0]
    expect(stamp).toMatch(ISO_8601_MS)
    expect(level).toBe('WARN')
    expect(message).toContain('Found 2 open PRs')
  })
})
