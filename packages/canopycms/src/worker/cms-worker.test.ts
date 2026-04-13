/**
 * Unit tests for CmsWorker internals that don't require real git operations.
 *
 * Integration-level tests (rebase, task queue) live in the sibling test files.
 */

import { describe, expect, it } from 'vitest'

import { CmsWorker } from './cms-worker'

const makeWorker = () =>
  new CmsWorker({
    workspacePath: '/tmp/fake-workspace',
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubToken: 'fake-token',
    taskTimeoutMs: 500,
  })

// ---------------------------------------------------------------------------
// stop() drains all active operations
// ---------------------------------------------------------------------------

describe('CmsWorker.stop()', () => {
  it('awaits all active operations before returning', async () => {
    const worker = makeWorker()
    const activeOps = (worker as unknown as { activeOperations: Set<Promise<void>> })
      .activeOperations

    const log: string[] = []

    const op1 = new Promise<void>((resolve) => {
      setTimeout(() => {
        log.push('op1')
        resolve()
      }, 20)
    })
    const op2 = new Promise<void>((resolve) => {
      setTimeout(() => {
        log.push('op2')
        resolve()
      }, 40)
    })

    activeOps.add(op1)
    activeOps.add(op2)

    // Prevent releaseLock from running (worker was never started/locked)
    ;(worker as unknown as { releaseLock(): Promise<void> }).releaseLock = async () => {}
    // Prevent the timeout from clearing activeTimeouts (it's already empty)
    ;(worker as unknown as { running: boolean }).running = false

    await worker.stop()

    expect(log).toContain('op1')
    expect(log).toContain('op2')
  })

  it('returns after taskTimeoutMs even if operations are still pending', async () => {
    const worker = makeWorker() // taskTimeoutMs = 500
    const activeOps = (worker as unknown as { activeOperations: Set<Promise<void>> })
      .activeOperations

    // Op that never resolves
    const hanging = new Promise<void>(() => {})
    activeOps.add(hanging)
    ;(worker as unknown as { releaseLock(): Promise<void> }).releaseLock = async () => {}
    ;(worker as unknown as { running: boolean }).running = false

    const start = Date.now()
    await worker.stop()
    const elapsed = Date.now() - start

    // Should have bailed after ~500ms (taskTimeoutMs), not hung forever
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(5000)
  })
})
