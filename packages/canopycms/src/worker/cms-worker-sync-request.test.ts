/**
 * Asking for the latest changes, on the worker's side: the sync-branch task only wakes the git
 * sync, which then runs early and coalesced, requested branches first. What the sync records for
 * the request is tested beside the rebase loop (cms-worker-rebase.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CmsWorker } from './cms-worker'
import { SYNC_BRANCH_ACTION } from '../base-update'
import type { Task } from '../task-queue/cms-task-queue'
import { mockConsole, type MockConsole } from '../test-utils'

type Internals = {
  running: boolean
  scheduleLoop(
    label: string,
    fn: () => Promise<void>,
    interval: number,
    early?: { requested: () => boolean; setWake: (wake: (() => void) | undefined) => void },
  ): void
  requestBranchSync(branchRef?: string): void
  takeBranchSyncRequests(): { branches: Set<string>; requested: boolean }
  gitSyncRequested: boolean
  wakeGitSync: (() => void) | undefined
  executeTask(task: Task, signal: AbortSignal): Promise<Record<string, unknown>>
  activeTimeouts: Set<NodeJS.Timeout>
}

const makeWorker = () =>
  new CmsWorker({
    workspacePath: '/tmp/fake-workspace',
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    baseBranch: 'main',
    githubToken: 'fake-token',
  })

const internalsOf = (worker: CmsWorker) => worker as unknown as Internals

const INTERVAL = 300_000
const MIN_REST = 10_000

describe('the git sync woken by a request', () => {
  let consoleSpy: MockConsole

  beforeEach(() => {
    consoleSpy = mockConsole()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    consoleSpy.restore()
  })

  /** Drive the git sync's loop as start() schedules it, counting its runs. */
  const startLoop = (worker: CmsWorker, runFor = 0, interval = INTERVAL) => {
    const internals = internalsOf(worker)
    internals.running = true
    const runs: number[] = []
    let finishRun: (() => void) | undefined
    internals.scheduleLoop(
      'git sync',
      async () => {
        runs.push(Date.now())
        internals.takeBranchSyncRequests()
        if (runFor > 0) await new Promise<void>((resolve) => (finishRun = resolve))
      },
      interval,
      {
        requested: () => internals.gitSyncRequested,
        setWake: (wake) => {
          internals.wakeGitSync = wake
        },
      },
    )
    return { internals, runs, finishRun: () => finishRun?.() }
  }

  const stopLoop = (internals: Internals) => {
    internals.running = false
    for (const t of internals.activeTimeouts) clearTimeout(t)
  }

  it('rests the full interval when nobody asks', async () => {
    const { internals, runs } = startLoop(makeWorker())
    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toHaveLength(1)
    stopLoop(internals)
  })

  it('runs as soon as it has rested the minimum when a request arrives during the rest', async () => {
    const { internals, runs } = startLoop(makeWorker())
    await vi.advanceTimersByTimeAsync(60_000)
    internals.requestBranchSync('content/a')
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toHaveLength(1)
    stopLoop(internals)
  })

  it('waits out the minimum rest, and repeated requests never push the run further out', async () => {
    const { internals, runs } = startLoop(makeWorker())
    await vi.advanceTimersByTimeAsync(2_000)
    internals.requestBranchSync('content/a')
    await vi.advanceTimersByTimeAsync(5_000)
    internals.requestBranchSync('content/b')
    await vi.advanceTimersByTimeAsync(MIN_REST - 7_000 - 1)
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toHaveLength(1)
    stopLoop(internals)
  })

  it('never rests longer for a request than its own interval when that is shorter', async () => {
    const { internals, runs } = startLoop(makeWorker(), 0, 2_000)
    internals.requestBranchSync('content/a')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(runs).toHaveLength(1)
    stopLoop(internals)
  })

  it('coalesces requests made during a run into one more run once it ends', async () => {
    const { internals, runs, finishRun } = startLoop(makeWorker(), 1)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(runs).toHaveLength(1)
    internals.requestBranchSync('content/a')
    internals.requestBranchSync('content/b')
    finishRun()
    await vi.advanceTimersByTimeAsync(MIN_REST)
    expect(runs).toHaveLength(2)
    finishRun()
    // Nothing more was asked, so the loop rests the full interval again.
    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(runs).toHaveLength(2)
    stopLoop(internals)
  })

  it('runs early at its first scheduling when a request came during the startup sync', async () => {
    const worker = makeWorker()
    internalsOf(worker).requestBranchSync('content/a')
    const { internals, runs } = startLoop(worker)
    await vi.advanceTimersByTimeAsync(MIN_REST)
    expect(runs).toHaveLength(1)
    stopLoop(internals)
  })
})

describe('the requests a sync cycle takes', () => {
  it('hands over the requested branches by directory name, once', () => {
    const internals = internalsOf(makeWorker())
    internals.requestBranchSync('canopycms/prod/content/a')
    internals.requestBranchSync()
    expect(internals.gitSyncRequested).toBe(true)
    expect([...internals.takeBranchSyncRequests().branches]).toEqual(['canopycms-prod-content-a'])
    expect(internals.gitSyncRequested).toBe(false)
    expect(internals.takeBranchSyncRequests()).toEqual({ branches: new Set(), requested: false })
  })
})

describe('the sync-branch task', () => {
  it('only asks the git sync for the branch', async () => {
    const internals = internalsOf(makeWorker())
    const result = await internals.executeTask(
      {
        id: 't1',
        action: SYNC_BRANCH_ACTION,
        payload: { branch: 'content/a' },
        status: 'processing',
        createdAt: new Date().toISOString(),
      },
      new AbortController().signal,
    )
    expect(result).toEqual({ requested: true })
    expect([...internals.takeBranchSyncRequests().branches]).toEqual(['content-a'])
  })

  it('fails for good without a branch', async () => {
    const internals = internalsOf(makeWorker())
    await expect(
      internals.executeTask(
        {
          id: 't1',
          action: SYNC_BRANCH_ACTION,
          payload: {},
          status: 'processing',
          createdAt: new Date().toISOString(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(internals.gitSyncRequested).toBe(false)
  })
})
