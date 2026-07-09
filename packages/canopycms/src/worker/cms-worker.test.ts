/**
 * Unit tests for CmsWorker internals that don't require real git operations.
 *
 * Integration-level tests (rebase, task queue) live in the sibling test files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CmsWorker, PermanentTaskError, isPermanentTaskFailure } from './cms-worker'
import { enqueueTask } from './task-queue'

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

// ---------------------------------------------------------------------------
// Worker lock: cross-host mutual exclusion (DEP-C2)
//
// The task queue is single-consumer, and the workspace lives on a shared
// filesystem (EFS) mounted by multiple hosts. The lock must therefore judge
// holder liveness purely by heartbeat freshness (lock mtime), never by local
// PID validity — a holder on another host has no PID on this machine.
// ---------------------------------------------------------------------------

type LockInternals = {
  acquireLock(): Promise<void>
  releaseLock(): Promise<void>
}

const lockInternals = (worker: CmsWorker) => worker as unknown as LockInternals

describe('CmsWorker lock (DEP-C2)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-lock-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeLockWorker = (lockStaleMs: number) =>
    new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      lockStaleMs,
    })

  const lockPath = () => path.join(tmpDir, '.tasks', '.worker-lock')

  it('does not take over a fresh lock even though no local process holds it', async () => {
    // Simulate a holder on ANOTHER HOST: the lock exists with a fresh
    // heartbeat (mtime = now), but no process on THIS machine owns it. A
    // PID-based liveness check would wrongly conclude the holder is dead and
    // steal the lock; heartbeat freshness must win.
    await fs.mkdir(lockPath(), { recursive: true })

    const worker = makeLockWorker(2000)
    await expect(lockInternals(worker).acquireLock()).rejects.toThrow(/Another worker/)
  })

  it('takes over a lock whose heartbeat is stale beyond the TTL', async () => {
    await fs.mkdir(lockPath(), { recursive: true })
    // Heartbeat far older than the 2s TTL — the holder is dead (crashed
    // without releasing) regardless of which host it ran on.
    const past = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath(), past, past)

    const worker = makeLockWorker(2000)
    await lockInternals(worker).acquireLock() // must succeed
    await lockInternals(worker).releaseLock()
  })

  it('holder heartbeat keeps the lock fresh past the TTL; release hands it over', async () => {
    const holder = makeLockWorker(3000)
    await lockInternals(holder).acquireLock()

    // Wait past the staleness TTL. The holder's heartbeat (mtime refresh
    // every TTL/2) must keep the lock fresh, so a second worker still cannot
    // acquire — even though more than TTL ms have elapsed since acquisition.
    await new Promise((r) => setTimeout(r, 4000))

    const contender = makeLockWorker(3000)
    await expect(lockInternals(contender).acquireLock()).rejects.toThrow(/Another worker/)

    await lockInternals(holder).releaseLock()
    await lockInternals(contender).acquireLock() // released lock is acquirable
    await lockInternals(contender).releaseLock()
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Task timeout bounds all task work, including signal-ignoring ops (DEP-H1)
// ---------------------------------------------------------------------------

type TaskInternals = {
  running: boolean
  executeTask(task: unknown, signal: AbortSignal): Promise<Record<string, unknown>>
}

describe('CmsWorker task timeout (DEP-H1)', () => {
  let tmpDir: string
  let taskDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-timeout-test-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeTimeoutWorker = () =>
    new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 200,
    })

  it('aborts a task whose work exceeds taskTimeoutMs and schedules a retry', async () => {
    const worker = makeTimeoutWorker()
    const internals = worker as unknown as TaskInternals
    internals.running = true
    // Simulate a hung git subprocess: never settles, ignores the AbortSignal.
    internals.executeTask = () => new Promise<Record<string, unknown>>(() => {})

    const id = await enqueueTask(taskDir, {
      action: 'push-branch',
      payload: { branch: 'feature-1' },
    })

    const started = Date.now()
    await worker.processTaskQueue() // must return, not hang on the stuck task
    expect(Date.now() - started).toBeLessThan(2000)

    // Timed-out attempt is treated as transient: back to pending for retry
    const pendingPath = path.join(taskDir, 'pending', `${id}.json`)
    const task = JSON.parse(await fs.readFile(pendingPath, 'utf-8'))
    expect(task.retryCount).toBe(1)
    expect(task.error).toMatch(/timed out after 200ms/)
  })
})

// ---------------------------------------------------------------------------
// Retry classification: transient vs permanent errors (DEP-L1)
// ---------------------------------------------------------------------------

describe('isPermanentTaskFailure (DEP-L1)', () => {
  const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

  it('classifies PermanentTaskError as permanent', () => {
    expect(isPermanentTaskFailure(new PermanentTaskError('bad payload'))).toBe(true)
  })

  it('classifies 4xx as permanent, except 408 and 429', () => {
    expect(isPermanentTaskFailure(withStatus(400))).toBe(true)
    expect(isPermanentTaskFailure(withStatus(404))).toBe(true)
    expect(isPermanentTaskFailure(withStatus(422))).toBe(true)
    expect(isPermanentTaskFailure(withStatus(408))).toBe(false)
    expect(isPermanentTaskFailure(withStatus(429))).toBe(false)
  })

  it('classifies 5xx and status-less errors as transient', () => {
    expect(isPermanentTaskFailure(withStatus(500))).toBe(false)
    expect(isPermanentTaskFailure(withStatus(503))).toBe(false)
    expect(isPermanentTaskFailure(new Error('socket hang up'))).toBe(false)
    expect(isPermanentTaskFailure('weird string error')).toBe(false)
  })
})

describe('CmsWorker retry behavior (DEP-L1)', () => {
  let tmpDir: string
  let taskDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-retry-test-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeRetryWorker = () =>
    new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 500,
    })

  const runWithFailure = async (error: unknown) => {
    const worker = makeRetryWorker()
    const internals = worker as unknown as TaskInternals
    internals.running = true
    internals.executeTask = () => Promise.reject(error)

    const id = await enqueueTask(taskDir, {
      action: 'push-branch',
      payload: { branch: 'feature-1' },
    })
    await worker.processTaskQueue()
    return id
  }

  const fileExists = async (p: string) => {
    try {
      await fs.stat(p)
      return true
    } catch {
      return false
    }
  }

  it('fails fast on a permanent 4xx error without burning retries', async () => {
    const id = await runWithFailure(Object.assign(new Error('Validation Failed'), { status: 422 }))

    const failed = JSON.parse(
      await fs.readFile(path.join(taskDir, 'failed', `${id}.json`), 'utf-8'),
    )
    expect(failed.status).toBe('failed')
    expect(failed.retryCount).toBe(0) // no retry attempts were spent
    expect(failed.error).toMatch(/Validation Failed/)
    expect(await fileExists(path.join(taskDir, 'pending', `${id}.json`))).toBe(false)
  })

  it('retries a transient 5xx error', async () => {
    const id = await runWithFailure(Object.assign(new Error('Server Error'), { status: 500 }))

    const pending = JSON.parse(
      await fs.readFile(path.join(taskDir, 'pending', `${id}.json`), 'utf-8'),
    )
    expect(pending.retryCount).toBe(1)
    expect(pending.retryAfter).toBeTruthy()
    expect(await fileExists(path.join(taskDir, 'failed', `${id}.json`))).toBe(false)
  })

  it('retries a 429 rate limit', async () => {
    const id = await runWithFailure(Object.assign(new Error('rate limited'), { status: 429 }))

    const pending = JSON.parse(
      await fs.readFile(path.join(taskDir, 'pending', `${id}.json`), 'utf-8'),
    )
    expect(pending.retryCount).toBe(1)
  })

  it('fails fast on a malformed payload via the real executeTask', async () => {
    // No stubbing: the real executeTask rejects with PermanentTaskError
    // before any git/GitHub work when a required payload field is missing.
    const worker = makeRetryWorker()
    ;(worker as unknown as TaskInternals).running = true

    const id = await enqueueTask(taskDir, { action: 'push-branch', payload: {} })
    await worker.processTaskQueue()

    const failed = JSON.parse(
      await fs.readFile(path.join(taskDir, 'failed', `${id}.json`), 'utf-8'),
    )
    expect(failed.error).toMatch(/missing required string field: branch/)
    expect(failed.retryCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// push-and-create-or-update-pr: idempotent PR submission (GIT-H1)
//
// The worker path must never blindly call pulls.create for a submit — if a
// prior attempt already created the PR on GitHub but crashed before this
// task completed and branch metadata recorded pullRequestNumber, a retry (or
// a fresh submit that re-enqueues the task) must recover the existing PR
// instead of 422-ing on a duplicate head+base, which would permanently wedge
// the branch in 'sync-failed'.
// ---------------------------------------------------------------------------

type PrWorkerInternals = {
  running: boolean
  octokit: {
    pulls: {
      list: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
  }
  pushBranchToGitHub(branch: string): Promise<void>
}

describe('CmsWorker push-and-create-or-update-pr (GIT-H1)', () => {
  let tmpDir: string
  let taskDir: string
  let contentBranchesPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-pr-test-'))
    taskDir = path.join(tmpDir, '.tasks')
    contentBranchesPath = path.join(tmpDir, 'content-branches')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const fileExists = async (p: string) => {
    try {
      await fs.stat(p)
      return true
    } catch {
      return false
    }
  }

  const makePrWorker = () => {
    const worker = new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 2000,
    })
    const internals = worker as unknown as PrWorkerInternals
    // Real git push is out of scope here (covered by pushBranchToGitHub's
    // own tests elsewhere); stub it so only the PR-creation logic is exercised.
    internals.pushBranchToGitHub = vi.fn().mockResolvedValue(undefined)
    internals.octokit = {
      pulls: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    }
    internals.running = true
    return { worker, internals }
  }

  const setupBranchDir = (branch: string) =>
    fs.mkdir(path.join(contentBranchesPath, branch), { recursive: true })

  const readBranchMeta = (branch: string) =>
    fs
      .readFile(path.join(contentBranchesPath, branch, '.canopy-meta', 'branch.json'), 'utf-8')
      .then(JSON.parse)

  it('recovers an orphaned PR instead of creating a duplicate, and records its number', async () => {
    // Simulates the GIT-H1 crash scenario: PR #77 already exists on GitHub
    // from a prior attempt, but branch metadata never got pullRequestNumber
    // (the process died first). This task carries no known PR number either.
    const { worker, internals } = makePrWorker()
    await setupBranchDir('feature-x')

    internals.octokit.pulls.list.mockResolvedValue({
      data: [
        {
          number: 77,
          html_url: 'https://github.com/test-owner/test-repo/pull/77',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    })

    const id = await enqueueTask(taskDir, {
      action: 'push-and-create-or-update-pr',
      payload: { branch: 'feature-x', title: 'Submit feature-x', body: 'desc' },
    })

    await worker.processTaskQueue()

    expect(internals.octokit.pulls.create).not.toHaveBeenCalled()
    expect(internals.octokit.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 77 }),
    )
    expect(await fileExists(path.join(taskDir, 'failed', `${id}.json`))).toBe(false)

    const meta = await readBranchMeta('feature-x')
    expect(meta.branch.pullRequestNumber).toBe(77)
    expect(meta.branch.syncStatus).toBe('synced')
  })

  it('creates a new PR on first submit and records its number', async () => {
    const { worker, internals } = makePrWorker()
    await setupBranchDir('feature-new')

    internals.octokit.pulls.list.mockResolvedValue({ data: [] })
    internals.octokit.pulls.create.mockResolvedValue({
      data: { number: 42, html_url: 'https://github.com/test-owner/test-repo/pull/42' },
    })

    await enqueueTask(taskDir, {
      action: 'push-and-create-or-update-pr',
      payload: { branch: 'feature-new', title: 'Submit feature-new', body: 'desc' },
    })

    await worker.processTaskQueue()

    expect(internals.octokit.pulls.update).not.toHaveBeenCalled()
    expect(internals.octokit.pulls.create).toHaveBeenCalled()

    const meta = await readBranchMeta('feature-new')
    expect(meta.branch.pullRequestNumber).toBe(42)
    expect(meta.branch.syncStatus).toBe('synced')
  })
})
