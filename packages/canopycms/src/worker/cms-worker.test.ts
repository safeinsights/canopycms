/**
 * Unit tests for CmsWorker internals that don't require real git operations.
 *
 * Integration-level tests (rebase, task queue) live in the sibling test files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'

import { CmsWorker, PermanentTaskError, isPermanentTaskFailure } from './cms-worker'
import { enqueueTask, dequeueTask } from './task-queue'
import { WORKER_STATUS_FILE } from './worker-status'
import { BranchMetadataFileManager } from '../branch-metadata'
import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import type { WorkerStatusReport } from '../types'

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
  // worker.stop() logs "CMS Worker stopped" by design; swallow it.
  let consoleSpy: MockConsole

  beforeEach(() => {
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

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
  // The timed-out task is logged as a failure by design; swallow it.
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-timeout-test-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    consoleSpy.restore()
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
    expect(consoleSpy).toHaveLogged('Will retry')
  })
})

// ---------------------------------------------------------------------------
// Retry classification: transient vs permanent errors (DEP-L1)
// ---------------------------------------------------------------------------

describe('isPermanentTaskFailure (DEP-L1)', () => {
  const withStatus = (
    status: number,
    opts?: { message?: string; headers?: Record<string, string> },
  ) =>
    Object.assign(new Error(opts?.message ?? `HTTP ${status}`), {
      status,
      ...(opts?.headers ? { response: { headers: opts.headers } } : {}),
    })

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

  it('classifies a bare 403 with no rate-limit signal as permanent', () => {
    expect(isPermanentTaskFailure(withStatus(403))).toBe(true)
  })

  it('classifies a 403 with x-ratelimit-remaining: 0 as transient', () => {
    expect(
      isPermanentTaskFailure(withStatus(403, { headers: { 'x-ratelimit-remaining': '0' } })),
    ).toBe(false)
  })

  it('classifies a 403 with a retry-after header as transient', () => {
    expect(isPermanentTaskFailure(withStatus(403, { headers: { 'retry-after': '60' } }))).toBe(
      false,
    )
  })

  it('classifies a 403 with a secondary rate limit message as transient', () => {
    expect(
      isPermanentTaskFailure(
        withStatus(403, { message: 'You have exceeded a secondary rate limit' }),
      ),
    ).toBe(false)
  })
})

describe('CmsWorker retry behavior (DEP-L1)', () => {
  let tmpDir: string
  let taskDir: string
  // Every test here drives a task failure, which the worker logs by design;
  // swallow that output and assert on it via the spy instead.
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-retry-test-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    consoleSpy.restore()
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
    expect(consoleSpy).toHaveErrored('Permanently failed')
  })

  it('retries a transient 5xx error', async () => {
    const id = await runWithFailure(Object.assign(new Error('Server Error'), { status: 500 }))

    const pending = JSON.parse(
      await fs.readFile(path.join(taskDir, 'pending', `${id}.json`), 'utf-8'),
    )
    expect(pending.retryCount).toBe(1)
    expect(pending.retryAfter).toBeTruthy()
    expect(await fileExists(path.join(taskDir, 'failed', `${id}.json`))).toBe(false)
    expect(consoleSpy).toHaveLogged('Will retry')
  })

  it('retries a 429 rate limit', async () => {
    const id = await runWithFailure(Object.assign(new Error('rate limited'), { status: 429 }))

    const pending = JSON.parse(
      await fs.readFile(path.join(taskDir, 'pending', `${id}.json`), 'utf-8'),
    )
    expect(pending.retryCount).toBe(1)
    expect(consoleSpy).toHaveLogged('Will retry')
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
    expect(consoleSpy).toHaveErrored('Permanently failed')
  })

  // [HIGH-1] task.error is persisted to failed/<id>.json and served to the
  // browser by the admin panel's Tasks tab. A git push failure's message
  // can embed the bot token (buildGitHubUrl() builds
  // https://x-access-token:TOKEN@github.com/...), so it must be redacted
  // before it reaches disk.
  it('redacts a token-bearing error message before persisting task.error via failTask', async () => {
    const id = await runWithFailure(
      Object.assign(
        new Error(
          "fatal: unable to access 'https://x-access-token:ghp_secret123456@github.com/org/repo.git/': Could not resolve host",
        ),
        { status: 422 }, // permanent -- goes straight to failTask, not retryTask
      ),
    )

    const failed = JSON.parse(
      await fs.readFile(path.join(taskDir, 'failed', `${id}.json`), 'utf-8'),
    )
    expect(failed.error).not.toContain('ghp_secret123456')
    expect(failed.error).toContain('***')
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
    graphql: ReturnType<typeof vi.fn>
  }
  pushBranchToGitHub(branch: string): Promise<void>
}

describe('CmsWorker push-and-create-or-update-pr (GIT-H1)', () => {
  let tmpDir: string
  let taskDir: string
  let contentBranchesPath: string
  // These tests exercise PR create/update/draft paths, each of which logs an
  // operational line by design; swallow that output so the reporter stays quiet.
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-pr-test-'))
    taskDir = path.join(tmpDir, '.tasks')
    contentBranchesPath = path.join(tmpDir, 'content-branches')
  })

  afterEach(async () => {
    consoleSpy.restore()
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
      graphql: vi.fn(),
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

  it('converts an existing draft PR to ready when the payload carries markReadyIfDraft', async () => {
    // Content submits (api/github-sync.ts) set markReadyIfDraft: true so a
    // pre-existing draft PR is converted to ready-for-review on submit.
    const { worker, internals } = makePrWorker()
    await setupBranchDir('feature-draft')

    internals.octokit.pulls.list.mockResolvedValue({
      data: [
        {
          number: 88,
          html_url: 'https://github.com/test-owner/test-repo/pull/88',
          updated_at: '2026-01-01T00:00:00Z',
          draft: true,
          node_id: 'PR_draft_88',
        },
      ],
    })

    await enqueueTask(taskDir, {
      action: 'push-and-create-or-update-pr',
      payload: {
        branch: 'feature-draft',
        title: 'Submit feature-draft',
        body: 'desc',
        markReadyIfDraft: true,
      },
    })

    await worker.processTaskQueue()

    expect(internals.octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('markPullRequestReadyForReview'),
      expect.objectContaining({ pullRequestId: 'PR_draft_88' }),
    )

    const meta = await readBranchMeta('feature-draft')
    expect(meta.branch.pullRequestNumber).toBe(88)
    expect(meta.branch.syncStatus).toBe('synced')
  })

  it('leaves an existing draft PR alone when the payload has no markReadyIfDraft flag', async () => {
    // Settings-branch syncs (services.ts) enqueue the same action without
    // the flag, so an existing draft PR must not be converted.
    const { worker, internals } = makePrWorker()
    await setupBranchDir('settings-sync')

    internals.octokit.pulls.list.mockResolvedValue({
      data: [
        {
          number: 89,
          html_url: 'https://github.com/test-owner/test-repo/pull/89',
          updated_at: '2026-01-01T00:00:00Z',
          draft: true,
          node_id: 'PR_draft_89',
        },
      ],
    })

    await enqueueTask(taskDir, {
      action: 'push-and-create-or-update-pr',
      payload: { branch: 'settings-sync', title: 'Update settings', body: 'desc' },
    })

    await worker.processTaskQueue()

    expect(internals.octokit.graphql).not.toHaveBeenCalled()

    const meta = await readBranchMeta('settings-sync')
    expect(meta.branch.pullRequestNumber).toBe(89)
    expect(meta.branch.syncStatus).toBe('synced')
  })

  // -------------------------------------------------------------------------
  // Protected base branch backstop: head === base must never reach GitHub,
  // even if the 'submittableBranch' API guard and the syncSubmitPr backstop
  // were both somehow bypassed (e.g. a task queued before this check
  // shipped). Defense-in-depth, last line before pushBranchToGitHub/octokit.
  // -------------------------------------------------------------------------

  it('refuses a push-and-create-or-update-pr task for the base branch (head === base)', async () => {
    // makePrWorker() doesn't set config.baseBranch, so this.baseBranch
    // defaults to 'main' (see CmsWorker constructor).
    const { worker, internals } = makePrWorker()
    await setupBranchDir('main')

    const id = await enqueueTask(taskDir, {
      action: 'push-and-create-or-update-pr',
      payload: { branch: 'main', title: 'Submit main', body: 'desc' },
    })

    await worker.processTaskQueue()

    expect(internals.pushBranchToGitHub).not.toHaveBeenCalled()
    expect(internals.octokit.pulls.list).not.toHaveBeenCalled()
    expect(internals.octokit.pulls.create).not.toHaveBeenCalled()
    expect(internals.octokit.pulls.update).not.toHaveBeenCalled()
    // PermanentTaskError -> fails immediately, landing in failed/ rather than
    // being retried (retrying can't make the branch not be the base branch).
    expect(await fileExists(path.join(taskDir, 'failed', `${id}.json`))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// pushBranchToGitHub(): push-rejection classification
//
// Two CanopyCMS deployments can share one GitHub repo; picking the same
// content-branch name surfaces as a real non-fast-forward push rejection.
// These tests exercise pushBranchToGitHub against REAL git repos (a bare
// "remote.git" plus a bare "githubFixture" standing in for GitHub -- same
// pattern as the pushSettingsBranches suite below) rather than mocking the
// error shape, so the classification is proven against git's actual output.
// ---------------------------------------------------------------------------

type PushBranchInternals = {
  pushBranchToGitHub(branch: string): Promise<void>
  buildGitHubUrl(): string
}

describe('CmsWorker.pushBranchToGitHub() [push-rejection classification]', () => {
  let tmpDir: string
  let workspacePath: string
  let remoteGitPath: string
  let githubFixture: string
  let contentBranchesPath: string
  let taskDir: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-push-rejection-'))
    workspacePath = path.join(tmpDir, 'workspace')
    remoteGitPath = path.join(workspacePath, 'remote.git')
    githubFixture = path.join(tmpDir, 'fixture-github.git')
    contentBranchesPath = path.join(workspacePath, 'content-branches')
    taskDir = path.join(workspacePath, '.tasks')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', remoteGitPath])
    await simpleGit().raw(['init', '--bare', githubFixture])
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makePushWorker = (taskTimeoutMs = 5000) => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs,
    })
    ;(worker as unknown as PushBranchInternals).buildGitHubUrl = () => githubFixture
    return worker
  }

  /** Seed branchName into remote.git with one commit, as a Lambda commit + GitManager.push would. */
  const seedBranchInRemoteGit = async (branchName: string, fileContent: string) => {
    const seedPath = path.join(tmpDir, `seed-${branchName}-${fileContent.length}`)
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await fs.writeFile(path.join(seedPath, 'file.txt'), fileContent)
    await seedGit.add(['file.txt'])
    await seedGit.commit('seed commit')
    await seedGit.raw(['branch', '-M', branchName])
    await seedGit.addRemote('origin', remoteGitPath)
    await seedGit.raw(['push', 'origin', `${branchName}:${branchName}`])
  }

  /** Seed branchName directly into githubFixture, simulating another deployment's push. */
  const seedBranchInGitHubFixture = async (branchName: string, fileContent: string) => {
    const seedPath = path.join(tmpDir, `seed-fixture-${branchName}`)
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await fs.writeFile(path.join(seedPath, 'other.txt'), fileContent)
    await seedGit.add(['other.txt'])
    await seedGit.commit('another deployment commit')
    await seedGit.raw(['branch', '-M', branchName])
    await seedGit.addRemote('origin', githubFixture)
    await seedGit.raw(['push', 'origin', `${branchName}:${branchName}`])
  }

  const fixtureHasBranch = async (branchName: string): Promise<boolean> => {
    const fixtureGit = simpleGit({ baseDir: githubFixture, config: ['safe.bareRepository=all'] })
    const branches = await fixtureGit.raw(['branch', '--list', branchName])
    return branches.trim().length > 0
  }

  it('pushes cleanly to GitHub when there is no collision', async () => {
    await seedBranchInRemoteGit('feature-clean', 'hello')
    const worker = makePushWorker()

    await (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature-clean')

    expect(await fixtureHasBranch('feature-clean')).toBe(true)
    expect(consoleSpy).toHaveLogged('Pushed feature-clean to GitHub')
  })

  it('throws PermanentTaskError naming the branch on a real non-fast-forward rejection', async () => {
    // The two-deployments-one-repo collision: 'feature-x' exists in BOTH this
    // deployment's remote.git AND (with different content) directly in
    // githubFixture, as if another deployment already pushed it.
    await seedBranchInRemoteGit('feature-x', 'this deployment')
    await seedBranchInGitHubFixture('feature-x', 'another deployment')

    const worker = makePushWorker()
    let caught: unknown
    try {
      await (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature-x')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(PermanentTaskError)
    expect((caught as Error).message).toContain('feature-x')
    // States the observable fact without prescribing a rename: a branch that
    // reaches this push usually has an open PR, which a rename would orphan.
    expect((caught as Error).message).toContain('has diverged and needs reconciling')
    expect((caught as Error).message).not.toContain('Rename')
    // The rejection must not have force-overwritten the other deployment's push.
    expect(await fixtureHasBranch('feature-x')).toBe(true)
  })

  it('rethrows a plain (non-PermanentTaskError) error for a real non-rejection push failure', async () => {
    // A real permission-denied failure (not a rejection): git's canonical
    // "Could not read from remote repository" message, captured the same way
    // as utils/git.test.ts's AUTH_FAILURE fixture (a locked-down bare repo),
    // not invented. Must stay transient -- isPermanentTaskFailure's git
    // carve-out already retries these; pushBranchToGitHub must not reclassify
    // them as permanent.
    await seedBranchInRemoteGit('feature-locked', 'hello')
    await fs.chmod(githubFixture, 0o000)

    const worker = makePushWorker()
    let caught: unknown
    try {
      await (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature-locked')
    } catch (err) {
      caught = err
    } finally {
      await fs.chmod(githubFixture, 0o755)
    }

    expect(caught).not.toBeInstanceOf(PermanentTaskError)
    expect(caught).toBeInstanceOf(Error)
  })

  // -------------------------------------------------------------------------
  // [SYNC-H1] Leased force push for history the rebase loop rewrote.
  //
  // When the rebase loop rewrites a branch whose history was already
  // published, it records the commit GitHub still holds
  // (`historyRewrittenFrom`). The push then runs under
  // `--force-with-lease=<branch>:<that commit>`, which moves GitHub off
  // exactly that commit and refuses in every other case.
  // -------------------------------------------------------------------------

  /** Write branch metadata carrying a pending history rewrite. */
  const writeRewriteMarker = async (branchName: string, marker: string) => {
    const branchPath = path.join(contentBranchesPath, branchName)
    await fs.mkdir(branchPath, { recursive: true })
    const meta = BranchMetadataFileManager.get(branchPath, contentBranchesPath)
    await meta.save({
      branch: {
        name: branchName,
        status: 'editing' as const,
        access: {},
        createdBy: 'test',
        historyRewrittenFrom: marker,
      },
    })
  }

  const readMarker = async (branchName: string): Promise<string | undefined> => {
    const file = await BranchMetadataFileManager.loadOnly(
      path.join(contentBranchesPath, branchName),
    )
    return file?.branch.historyRewrittenFrom
  }

  const shaOf = async (repo: string, ref: string): Promise<string> =>
    (await simpleGit().raw(['--git-dir', repo, 'rev-parse', '--verify', ref])).trim()

  it('force-pushes rewritten history over exactly the commit it replaced, then clears the marker', async () => {
    // GitHub holds the pre-rebase commit; remote.git holds the rewritten one.
    // A plain push would be rejected non-fast-forward forever.
    await seedBranchInGitHubFixture('feature-rebased', 'pre-rebase')
    const published = await shaOf(githubFixture, 'refs/heads/feature-rebased')
    await seedBranchInRemoteGit('feature-rebased', 'rewritten by the rebase loop')
    const rewrittenTip = await shaOf(remoteGitPath, 'refs/heads/feature-rebased')
    await writeRewriteMarker('feature-rebased', published)

    const worker = makePushWorker()
    await (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature-rebased')

    expect(await shaOf(githubFixture, 'refs/heads/feature-rebased')).toBe(rewrittenTip)
    // GitHub now holds something other than the marker, so the lease has done
    // its job and must not be reused.
    expect(await readMarker('feature-rebased')).toBeUndefined()
  })

  it('succeeds when an earlier attempt already landed the same commit (crash-retry idempotency)', async () => {
    // Tasks are re-run after a crash (recoverOrphanedTasks). The push landed
    // but the worker died before clearing the marker, so remote.git and
    // GitHub already agree. git evaluates a lease only when it actually has
    // an update to apply, so this is absorbed as "Everything up-to-date"
    // rather than reaching the refusal path at all.
    await seedBranchInRemoteGit('feature-relanded', 'rewritten')
    const tip = await shaOf(remoteGitPath, 'refs/heads/feature-relanded')
    // The earlier attempt: the same commit already reached GitHub.
    await simpleGit().raw([
      '--git-dir',
      remoteGitPath,
      'push',
      githubFixture,
      'feature-relanded:feature-relanded',
    ])
    // A marker naming a commit GitHub has already moved off.
    await writeRewriteMarker('feature-relanded', '0'.repeat(40))

    const worker = makePushWorker()
    await expect(
      (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature-relanded'),
    ).resolves.toBeUndefined()

    expect(await shaOf(githubFixture, 'refs/heads/feature-relanded')).toBe(tip)
    expect(await readMarker('feature-relanded')).toBeUndefined()
  })

  it('finds the marker for a branch whose workspace directory name is sanitized', async () => {
    // Branch workspace directories are named with sanitizeBranchName (see
    // resolveBranchPaths), but task payloads carry the RAW git ref name --
    // they differ for any name outside [A-Za-z0-9._-], '/' being the obvious
    // one. Joining the raw name onto contentBranchesPath misses the directory
    // entirely, so the marker reads as absent, the push goes out unleased,
    // and the branch wedges exactly as it did before this fix.
    await seedBranchInGitHubFixture('feature/slashed', 'pre-rebase')
    const published = await shaOf(githubFixture, 'refs/heads/feature/slashed')
    await seedBranchInRemoteGit('feature/slashed', 'rewritten by the rebase loop')
    const rewrittenTip = await shaOf(remoteGitPath, 'refs/heads/feature/slashed')
    // Marker lives in the SANITIZED directory, as the rebase loop writes it.
    await writeRewriteMarker('feature-slashed', published)

    const worker = makePushWorker()
    await (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature/slashed')

    expect(await shaOf(githubFixture, 'refs/heads/feature/slashed')).toBe(rewrittenTip)
    expect(await readMarker('feature-slashed')).toBeUndefined()
  })

  it('still fast-forwards when the marker is stale and the branch has moved on since', async () => {
    // The wedge this guards against: git refuses a stale lease even when the
    // update is an ordinary fast-forward. GitHub holds the rewritten commit
    // from an earlier attempt, the editor has since submitted more work, and
    // the marker was never cleared -- pushing under it fails, and would keep
    // failing for every later submit on this branch.
    await seedBranchInRemoteGit('feature-moved-on', 'rewritten')
    await simpleGit().raw([
      '--git-dir',
      remoteGitPath,
      'push',
      githubFixture,
      'feature-moved-on:feature-moved-on',
    ])
    const landed = await shaOf(githubFixture, 'refs/heads/feature-moved-on')

    // New editor work on top, reaching remote.git only.
    const morePath = path.join(tmpDir, 'more-work')
    await simpleGit().clone(remoteGitPath, morePath, ['--branch', 'feature-moved-on'])
    const moreGit = simpleGit({ baseDir: morePath })
    await moreGit.addConfig('user.name', 'Editor')
    await moreGit.addConfig('user.email', 'editor@canopycms.test')
    await fs.writeFile(path.join(morePath, 'file.txt'), 'more editor work')
    await moreGit.add(['file.txt'])
    await moreGit.commit('more editor work')
    await moreGit.raw(['push', 'origin', 'feature-moved-on:feature-moved-on'])
    const newTip = await shaOf(remoteGitPath, 'refs/heads/feature-moved-on')
    await writeRewriteMarker('feature-moved-on', '0'.repeat(40))

    const worker = makePushWorker()
    await (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature-moved-on')

    expect(newTip).not.toBe(landed)
    expect(await shaOf(githubFixture, 'refs/heads/feature-moved-on')).toBe(newTip)
    expect(await readMarker('feature-moved-on')).toBeUndefined()
    expect(consoleSpy).toHaveLogged('already moved past the rewritten commit')
  })

  it('refuses to force over a GitHub tip that is neither the marker nor what it is pushing', async () => {
    // Someone else moved the branch on GitHub. The lease refuses, nothing is
    // overwritten, and the task fails permanently with the honest reason.
    await seedBranchInGitHubFixture('feature-moved', 'someone else')
    const foreignTip = await shaOf(githubFixture, 'refs/heads/feature-moved')
    await seedBranchInRemoteGit('feature-moved', 'ours')
    await writeRewriteMarker('feature-moved', '0'.repeat(40))

    const worker = makePushWorker()
    let caught: unknown
    try {
      await (worker as unknown as PushBranchInternals).pushBranchToGitHub('feature-moved')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(PermanentTaskError)
    expect((caught as Error).message).toContain(
      'has genuinely diverged and nothing was overwritten',
    )
    expect((caught as Error).message).not.toContain('Rename')
    // The other party's commit survives, and the marker is kept for a
    // human-reconciled retry rather than silently dropped.
    expect(await shaOf(githubFixture, 'refs/heads/feature-moved')).toBe(foreignTip)
    expect(await readMarker('feature-moved')).toBe('0'.repeat(40))
  })

  it('fails a push-branch task immediately (not after maxRetries) on a real rejection, and records the reason on branch metadata', async () => {
    await seedBranchInRemoteGit('feature-collision', 'this deployment')
    await seedBranchInGitHubFixture('feature-collision', 'another deployment')
    await fs.mkdir(path.join(contentBranchesPath, 'feature-collision'), { recursive: true })

    const worker = makePushWorker()
    ;(worker as unknown as { running: boolean }).running = true

    const id = await enqueueTask(taskDir, {
      action: 'push-branch',
      payload: { branch: 'feature-collision' },
    })

    await worker.processTaskQueue()

    // Fails fast: lands in failed/ with retryCount 0 (the retry budget was
    // never touched), not pending/ with retries burned toward maxRetries.
    const failed = JSON.parse(
      await fs.readFile(path.join(taskDir, 'failed', `${id}.json`), 'utf-8'),
    )
    expect(failed.retryCount).toBe(0)
    expect(failed.error).toContain('feature-collision')
    expect(
      await fs
        .stat(path.join(taskDir, 'pending', `${id}.json`))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)

    const meta = JSON.parse(
      await fs.readFile(
        path.join(contentBranchesPath, 'feature-collision', '.canopy-meta', 'branch.json'),
        'utf-8',
      ),
    )
    expect(meta.branch.syncStatus).toBe('sync-failed')
    expect(meta.branch.syncFailureReason).toContain('feature-collision')
    expect(meta.branch.syncFailureReason).toContain('has diverged and needs reconciling')
  })
})

// ---------------------------------------------------------------------------
// ensureRemoteGit(): empty-remote guard (adopter protection)
//
// simple-git's bare clone of an EMPTY GitHub repo (no commits, or a base
// branch that's never been pushed) exits 0 and produces a refs-less bare
// repo -- HEAD points at an unborn branch, and `fs.stat` alone can't tell
// this apart from a healthy clone. Left unchecked this silently poisons
// remote.git for every later branch operation (Lambda-side clone
// provisioning, worker pushes), and the fs.stat short-circuit means it never
// heals on its own.
//
// These tests exercise the guard against real git repos (no network calls --
// buildGitHubUrl is stubbed to point at a local bare "GitHub" fixture).
// ---------------------------------------------------------------------------

type RemoteGitInternals = {
  ensureRemoteGit(): Promise<void>
  buildGitHubUrl(): string
}

describe('CmsWorker.ensureRemoteGit() empty-remote guard', () => {
  let tmpDir: string
  let fixtureRemote: string // simulated "GitHub" repo
  let workspacePath: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-empty-remote-test-'))
    fixtureRemote = path.join(tmpDir, 'fixture-github.git')
    workspacePath = path.join(tmpDir, 'workspace')
    await fs.mkdir(workspacePath, { recursive: true })
    // The simulated GitHub repo: bare, no commits, no refs at all.
    await simpleGit().raw(['init', '--bare', fixtureRemote])
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeGuardWorker = (baseBranch = 'main') => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch,
    })
    // Point clone/fetch/push at the local fixture instead of a real GitHub URL.
    ;(worker as unknown as RemoteGitInternals).buildGitHubUrl = () => fixtureRemote
    return worker
  }

  const remoteGitPath = () => path.join(workspacePath, 'remote.git')

  const fileExists = async (p: string) => {
    try {
      await fs.stat(p)
      return true
    } catch {
      return false
    }
  }

  /** Push an initial commit to the fixture's base branch, as an operator would after the guard fires. */
  const pushInitialCommitToFixture = async (seedName: string, baseBranch = 'main') => {
    const seedPath = path.join(tmpDir, seedName)
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await seedGit.raw(['branch', '-M', baseBranch])
    await fs.writeFile(path.join(seedPath, 'README.md'), '# hello\n')
    await seedGit.add(['.'])
    await seedGit.commit('initial commit')
    await seedGit.addRemote('origin', fixtureRemote)
    await seedGit.push('origin', baseBranch)
  }

  it('rejects a fresh clone of an empty repo and deletes the poisoned clone', async () => {
    const worker = makeGuardWorker()
    const internals = worker as unknown as RemoteGitInternals

    await expect(internals.ensureRemoteGit()).rejects.toThrow(/no branch/)
    // The just-cloned, refs-less remote.git must be removed -- that's what
    // makes the failure recoverable (the next start() re-clones instead of
    // being stuck behind a poisoned clone that fs.stat can't detect).
    expect(await fileExists(remoteGitPath())).toBe(false)
  })

  it('self-heals: a subsequent ensureRemoteGit succeeds after the base branch is pushed', async () => {
    const worker = makeGuardWorker()
    const internals = worker as unknown as RemoteGitInternals
    await expect(internals.ensureRemoteGit()).rejects.toThrow(/no branch/)
    expect(await fileExists(remoteGitPath())).toBe(false)

    await pushInitialCommitToFixture('seed')

    // A fresh worker (matching a systemd restart) succeeds now.
    const retryWorker = makeGuardWorker()
    await (retryWorker as unknown as RemoteGitInternals).ensureRemoteGit()
    expect(await fileExists(remoteGitPath())).toBe(true)
  })

  it('rejects an already-existing remote.git that lacks the base branch, without deleting it', async () => {
    // Simulate a remote.git left behind by a pre-guard worker run (or any
    // other means) that never got a base branch: an empty bare repo created
    // directly at the workspace's remote.git path, with no fixture clone
    // involved.
    await simpleGit().raw(['init', '--bare', remoteGitPath()])

    const worker = makeGuardWorker()
    const internals = worker as unknown as RemoteGitInternals

    await expect(internals.ensureRemoteGit()).rejects.toThrow(/no branch/)
    // Existing repos are not auto-deleted -- they may hold unpushed
    // canopycms-settings-* branches or other state; removal is the
    // operator's call, per the error message's recovery hint.
    expect(await fileExists(remoteGitPath())).toBe(true)
  })

  it('does not leave the cross-host lock held after start() fails on the empty-remote guard', async () => {
    const worker = makeGuardWorker()
    await expect(worker.start()).rejects.toThrow(/no branch/)

    // A second worker against the same workspace must be able to acquire the
    // lock immediately -- it must not still be held from the failed start().
    const contender = makeGuardWorker()
    await lockInternals(contender).acquireLock()
    await lockInternals(contender).releaseLock()

    // PR-W1: the startup failure must be visible to the admin panel via
    // worker-status.json, not only worker logs -- lastFatalError.phase
    // distinguishes it from a mid-run failure.
    const statusPath = path.join(workspacePath, '.tasks', WORKER_STATUS_FILE)
    const status = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as WorkerStatusReport
    expect(status.lastFatalError?.phase).toBe('startup')
    expect(status.lastFatalError?.message).toMatch(/no branch/)
    expect(status.lastFatalError?.at).toBeTruthy()
  })

  it('clones successfully when the fixture already has a base branch commit (happy path unaffected)', async () => {
    await pushInitialCommitToFixture('seed-happy')

    const worker = makeGuardWorker()
    const internals = worker as unknown as RemoteGitInternals
    await internals.ensureRemoteGit()
    expect(await fileExists(remoteGitPath())).toBe(true)

    // Already-exists fast path must also succeed without error on a second call.
    await internals.ensureRemoteGit()
    expect(await fileExists(remoteGitPath())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// worker-status.json bookkeeping (PR-W1)
//
// The worker self-reports a status snapshot so a dead-or-sick worker is
// distinguishable from a healthy idle one via the admin panel
// (api/admin.ts's readWorkerStatus). syncGit() records a per-cycle summary
// (success or hard failure); processTaskQueue() records only when it did
// real work, to avoid an EFS write on every idle 5s poll.
// ---------------------------------------------------------------------------

describe('CmsWorker.syncGit() worker-status.json bookkeeping', () => {
  let tmpDir: string
  let workspacePath: string
  let fixtureRemote: string

  const statusPath = () => path.join(workspacePath, '.tasks', WORKER_STATUS_FILE)
  const readStatus = async (): Promise<WorkerStatusReport> =>
    JSON.parse(await fs.readFile(statusPath(), 'utf-8'))

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-status-sync-test-'))
    workspacePath = path.join(tmpDir, 'workspace')
    fixtureRemote = path.join(tmpDir, 'fixture-github.git')

    await fs.mkdir(workspacePath, { recursive: true })
    // Top-level bare mirror that syncGit() fetches into (mirrors what
    // ensureRemoteGit() would have provisioned -- these tests call
    // syncGit() directly, so it's set up by hand here).
    await simpleGit().raw(['init', '--bare', path.join(workspacePath, 'remote.git')])

    // Simulated "GitHub", seeded with an initial commit on main so
    // syncGit()'s fetch has something to pull (same fixture pattern as the
    // ensureRemoteGit() empty-remote-guard tests above).
    await simpleGit().raw(['init', '--bare', fixtureRemote])
    const seedPath = path.join(tmpDir, 'fixture-seed')
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await seedGit.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(seedPath, 'README.md'), '# hello\n')
    await seedGit.add(['.'])
    await seedGit.commit('initial commit')
    await seedGit.addRemote('origin', fixtureRemote)
    await seedGit.push('origin', 'main')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /**
   * A branch-workspace clone with its own independent "origin" (unrelated
   * to remote.git/fixtureRemote above) -- the same shape
   * cms-worker-rebase.test.ts's createBranchSetup uses, trimmed to what
   * these tests need.
   */
  const createSyncBranch = async (branchName: string) => {
    const originPath = path.join(tmpDir, `${branchName}-origin`)
    const branchPath = path.join(workspacePath, 'content-branches', branchName)

    await fs.mkdir(originPath, { recursive: true })
    const originGit = await initTestRepo(originPath)
    await originGit.raw(['branch', '-M', 'main'])
    await fs.writeFile(path.join(originPath, '.gitkeep'), '')
    await originGit.add(['.'])
    await originGit.commit('initial commit')

    await fs.mkdir(path.join(workspacePath, 'content-branches'), { recursive: true })
    await simpleGit().clone(originPath, branchPath)

    const branchGit = simpleGit({ baseDir: branchPath, unsafe: { allowUnsafeEditor: true } })
    await branchGit.addConfig('user.name', 'Test Bot')
    await branchGit.addConfig('user.email', 'test@canopycms.test')
    await branchGit.addConfig('core.editor', 'true')
    await branchGit.checkoutBranch(branchName, 'origin/main')
    await branchGit.raw(['branch', '--set-upstream-to=origin/main', branchName])

    return { branchPath, branchGit, originGit, originPath }
  }

  const makeSyncWorker = () => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    ;(worker as unknown as { buildGitHubUrl(): string }).buildGitHubUrl = () => fixtureRemote
    ;(worker as unknown as { running: boolean }).running = true
    return worker
  }

  it('records lastGitSyncAt and a rebase summary after a successful cycle, including a per-branch rebase failure', async () => {
    // Behind, no conflicts -> should complete and land in lastGitSync.rebased.
    const behind = await createSyncBranch('behind-branch')
    await fs.writeFile(path.join(behind.originPath, 'remote-update.txt'), 'from origin')
    await behind.originGit.add(['.'])
    await behind.originGit.commit('advance origin')

    // Origin fetch will throw -> should land in lastGitSync.failed.
    const broken = await createSyncBranch('broken-branch')
    await broken.branchGit.raw(['remote', 'set-url', 'origin', '/nonexistent/path'])

    const worker = makeSyncWorker()
    await worker.syncGit()

    const status = await readStatus()
    expect(status.lastGitSyncAt).toBeTruthy()
    expect(status.lastGitSyncError).toBeUndefined()
    expect(status.lastGitSync).toBeDefined()
    expect(status.lastGitSync?.durationMs).toBeGreaterThanOrEqual(0)
    expect(status.lastGitSync?.rebased).toContain('behind-branch')
    expect(status.lastGitSync?.failed.map((f) => f.branch)).toContain('broken-branch')
  })

  it('records lastGitSyncError and still rethrows on a hard sync-cycle failure', async () => {
    const worker = makeSyncWorker()
    // Point the top-level fetch at a path with no git repo at all -- fails
    // immediately, no network involved, before any rebase work runs.
    ;(worker as unknown as { buildGitHubUrl(): string }).buildGitHubUrl = () =>
      '/nonexistent/definitely-not-a-remote.git'

    await expect(worker.syncGit()).rejects.toThrow()

    const status = await readStatus()
    expect(status.lastGitSyncError?.message).toBeTruthy()
    expect(status.lastGitSyncError?.at).toBeTruthy()
    expect(status.lastGitSyncAt).toBeUndefined()
  })

  it('redacts a token-bearing error message before persisting it to worker-status.json (HIGH-1)', async () => {
    const worker = makeSyncWorker()
    // A local nonexistent path (no `://`) so git fails immediately without
    // any network attempt, while still echoing the literal string back
    // verbatim in its fatal message -- simulating a fetch/push error whose
    // text embeds the bot token, same shape as buildGitHubUrl()'s
    // https://x-access-token:TOKEN@github.com/... URLs.
    ;(worker as unknown as { buildGitHubUrl(): string }).buildGitHubUrl = () =>
      path.join(tmpDir, 'x-access-token:ghp_secret123456@nonexistent', 'remote.git')

    await expect(worker.syncGit()).rejects.toThrow()

    const status = await readStatus()
    expect(status.lastGitSyncError?.message).toBeTruthy()
    expect(status.lastGitSyncError?.message).not.toContain('ghp_secret123456')
    expect(status.lastGitSyncError?.message).toContain('***')
  })
})

describe('CmsWorker.processTaskQueue() worker-status.json bookkeeping', () => {
  let tmpDir: string
  let taskDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-status-task-test-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const statusPath = () => path.join(taskDir, WORKER_STATUS_FILE)

  const makeWorker = () => {
    const worker = new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 500,
    })
    ;(worker as unknown as TaskInternals).running = true
    return worker
  }

  it('sets lastTaskCycleAt after processing >=1 task, and does not rewrite the file on a subsequent idle poll', async () => {
    const worker = makeWorker()
    const internals = worker as unknown as TaskInternals
    internals.executeTask = () => Promise.resolve({ pushed: true })

    await enqueueTask(taskDir, { action: 'push-branch', payload: { branch: 'feature-1' } })
    await worker.processTaskQueue()

    const raw1 = await fs.readFile(statusPath(), 'utf-8')
    const status1 = JSON.parse(raw1) as WorkerStatusReport
    expect(status1.lastTaskCycleAt).toBeTruthy()

    // Idle poll: no pending tasks -- must not touch worker-status.json at
    // all (liveness already comes from the lock heartbeat; see
    // api/admin.ts's classifyWorkerLiveness), not even to re-stamp updatedAt.
    await worker.processTaskQueue()
    const raw2 = await fs.readFile(statusPath(), 'utf-8')
    expect(raw2).toBe(raw1)
  })

  it('does not write worker-status.json at all when no tasks are pending', async () => {
    const worker = makeWorker()
    await worker.processTaskQueue()

    await expect(fs.stat(statusPath())).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Orphan recovery runs on every processTaskQueue() cycle, not only at boot.
//
// Before this fix, recoverOrphanedTasks() ran exactly once, from start().
// That was fine when instance replacement was rare (a spot interruption),
// but CanopyCmsService's worker ASG now rolls the instance on every
// `cdk deploy` (see its UpdatePolicy in cms-service.ts), making replacement
// routine: a task file left in processing/ by the terminated instance is
// younger than the 5-minute default staleness threshold by the time the
// replacement boots (2-4 minutes of yum install + EFS mount), so a
// boot-only recovery call would skip it -- and with nothing re-scanning
// afterward, the task (and its branch's syncStatus) would be stuck forever.
// ---------------------------------------------------------------------------

describe('CmsWorker.processTaskQueue() recovers orphaned tasks every cycle (not only at boot)', () => {
  let tmpDir: string
  let taskDir: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-orphan-cycle-test-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeOrphanWorker = () => {
    const worker = new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 500,
    })
    ;(worker as unknown as TaskInternals).running = true
    return worker
  }

  it('recovers a task stranded in processing/ on a later processTaskQueue() cycle, without start() ever running', async () => {
    const worker = makeOrphanWorker()
    const internals = worker as unknown as TaskInternals
    internals.executeTask = () => Promise.resolve({ pushed: true })

    const id = await enqueueTask(taskDir, {
      action: 'push-branch',
      payload: { branch: 'feature-1' },
    })

    // Simulate a mid-task instance termination: move the task into
    // processing/ directly (bypassing processTaskQueue, which would
    // complete/fail/retry it) -- exactly the state a terminated instance
    // leaves behind.
    const dequeued = await dequeueTask(taskDir)
    expect(dequeued!.id).toBe(id)

    // Backdate the processing/ file's mtime past recoverOrphanedTasks()'s
    // 5-minute default threshold, standing in for time actually elapsing
    // (replacement instance boot + however long it sits before the next
    // poll) rather than sleeping for real in a test.
    const processingPath = path.join(taskDir, 'processing', `${id}.json`)
    const past = new Date(Date.now() - 6 * 60_000)
    await fs.utimes(processingPath, past, past)

    // start() is deliberately never called here. A single processTaskQueue()
    // call -- standing in for one taskPollInterval cycle on an
    // already-running worker -- must recover it on its own; if recovery only
    // happened in start(), this file would stay wedged in processing/
    // forever, since nothing else re-scans it.
    await worker.processTaskQueue()

    await expect(fs.stat(processingPath)).rejects.toThrow()
    const completed = JSON.parse(
      await fs.readFile(path.join(taskDir, 'completed', `${id}.json`), 'utf-8'),
    )
    expect(completed.status).toBe('completed')
    expect(completed.result.pushed).toBe(true)
    expect(consoleSpy).toHaveLogged('Recovered 1 orphaned task(s)')
  })
})

// ---------------------------------------------------------------------------
// cleanupTrashedBranchDirs() [C1] -- worker-only retention sweep for the
// admin purge action's `.trash-{dirName}-{STAMP}` directories
// (api/admin-branch-health.ts). Age comes ONLY from the name-embedded stamp
// (constructed by hand here), never the directory's own mtime -- see the
// method's doc comment in cms-worker.ts for why.
// ---------------------------------------------------------------------------

type TrashCleanupInternals = {
  cleanupTrashedBranchDirs(): Promise<number>
}

describe('CmsWorker.cleanupTrashedBranchDirs() [C1]', () => {
  let tmpDir: string
  let contentBranchesPath: string

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-trash-cleanup-test-'))
    contentBranchesPath = path.join(tmpDir, 'content-branches')
    await fs.mkdir(contentBranchesPath, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeWorker = () =>
    new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
    })

  /** Format a Date as the purge-generated `YYYYMMDDTHHMMSSZ` stamp (no colons). */
  const stamp = (date: Date) =>
    date
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z')

  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000)

  it('removes a trash dir stamped more than 30 days ago', async () => {
    const dirName = `.trash-old-branch-${stamp(daysAgo(31))}`
    await fs.mkdir(path.join(contentBranchesPath, dirName), { recursive: true })

    const worker = makeWorker()
    const removed = await (worker as unknown as TrashCleanupInternals).cleanupTrashedBranchDirs()

    expect(removed).toBe(1)
    await expect(fs.stat(path.join(contentBranchesPath, dirName))).rejects.toThrow()
  })

  it('keeps a trash dir stamped 1 day ago', async () => {
    const dirName = `.trash-recent-branch-${stamp(daysAgo(1))}`
    await fs.mkdir(path.join(contentBranchesPath, dirName), { recursive: true })

    const worker = makeWorker()
    const removed = await (worker as unknown as TrashCleanupInternals).cleanupTrashedBranchDirs()

    expect(removed).toBe(0)
    await expect(fs.stat(path.join(contentBranchesPath, dirName))).resolves.toBeTruthy()
  })

  it('keeps and logs an unparseable trash dir name instead of throwing', async () => {
    const dirName = '.trash-foo'
    await fs.mkdir(path.join(contentBranchesPath, dirName), { recursive: true })

    const worker = makeWorker()
    const removed = await (worker as unknown as TrashCleanupInternals).cleanupTrashedBranchDirs()

    expect(removed).toBe(0)
    await expect(fs.stat(path.join(contentBranchesPath, dirName))).resolves.toBeTruthy()
  })

  it('ignores an mtime-only rewrite of an old-stamped dir -- age comes from the name, not mtime', async () => {
    // Simulates the exact scenario the [C1] design note warns about:
    // fs.rename (what purge does) preserves the original directory's mtime,
    // so a months-stale orphan's trash dir would otherwise look "fresh" only
    // if cleanup incorrectly used mtime. Here we go the other way -- an
    // old-stamped name whose mtime we bump to "now" must still be removed,
    // proving age is read from the name alone.
    const dirName = `.trash-touched-branch-${stamp(daysAgo(60))}`
    const dirPath = path.join(contentBranchesPath, dirName)
    await fs.mkdir(dirPath, { recursive: true })
    const now = new Date()
    await fs.utimes(dirPath, now, now)

    const worker = makeWorker()
    const removed = await (worker as unknown as TrashCleanupInternals).cleanupTrashedBranchDirs()

    expect(removed).toBe(1)
    await expect(fs.stat(dirPath)).rejects.toThrow()
  })

  it('returns 0 when contentBranchesPath does not exist yet', async () => {
    await fs.rm(contentBranchesPath, { recursive: true, force: true })

    const worker = makeWorker()
    const removed = await (worker as unknown as TrashCleanupInternals).cleanupTrashedBranchDirs()

    expect(removed).toBe(0)
  })

  it('ignores non-trash directories entirely', async () => {
    await fs.mkdir(path.join(contentBranchesPath, 'main'), { recursive: true })
    await fs.mkdir(path.join(contentBranchesPath, '.canopy-meta'), { recursive: true })

    const worker = makeWorker()
    const removed = await (worker as unknown as TrashCleanupInternals).cleanupTrashedBranchDirs()

    expect(removed).toBe(0)
    await expect(fs.stat(path.join(contentBranchesPath, 'main'))).resolves.toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// pushSettingsBranches: pushes only this deployment's own settings branch
// ---------------------------------------------------------------------------
//
// Since the tracking-namespace fetch fix (GITHUB_TRACKING_REF_PREFIX),
// reconcileTrackedBranches() creates local heads in remote.git for any branch
// that exists on GitHub - including another deployment's settings branch, if
// it shares this GitHub repo. pushSettingsBranches must push ONLY the branch
// this worker owns (CmsWorkerConfig.deploymentName) and warn about (never
// push) any other canopycms-settings-* branch it finds locally.

type PushSettingsBranchesInternals = {
  pushSettingsBranches(
    git: ReturnType<typeof simpleGit>,
    // Branch names syncGit() saw on GitHub this cycle. A foreign settings
    // branch missing from this set was pushed into remote.git locally and
    // never reached GitHub -- see the [SYNC-M3] check in the implementation.
    trackedNames: ReadonlySet<string>,
  ): Promise<void>
}

describe('CmsWorker.pushSettingsBranches() [deployment-namespaced settings branches]', () => {
  let tmpDir: string
  let workspacePath: string
  let remoteGitPath: string
  let githubFixture: string // simulated "GitHub" bare repo, what pushes land in
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-settings-push-'))
    workspacePath = path.join(tmpDir, 'workspace')
    remoteGitPath = path.join(workspacePath, 'remote.git')
    githubFixture = path.join(tmpDir, 'fixture-github.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', remoteGitPath])
    await simpleGit().raw(['init', '--bare', githubFixture])
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** Seed a branch (with one commit) directly into the bare remote.git, as a
   * Lambda commit + GitManager.push would. */
  const seedBranchInRemoteGit = async (branchName: string, fileContent: string) => {
    const seedPath = path.join(tmpDir, `seed-${branchName}`)
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await seedGit.raw(['checkout', '--orphan', branchName])
    await fs.writeFile(path.join(seedPath, 'permissions.json'), fileContent)
    await seedGit.add(['permissions.json'])
    await seedGit.commit('seed settings')
    await seedGit.addRemote('origin', remoteGitPath)
    await seedGit.raw(['push', 'origin', `${branchName}:${branchName}`])
  }

  const makeSettingsWorker = (deploymentName?: string) => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      deploymentName,
    })
    ;(worker as unknown as { buildGitHubUrl(): string }).buildGitHubUrl = () => githubFixture
    return worker
  }

  const fixtureHasBranch = async (branchName: string): Promise<boolean> => {
    const fixtureGit = simpleGit({ baseDir: githubFixture, config: ['safe.bareRepository=all'] })
    const branches = await fixtureGit.raw(['branch', '--list', branchName])
    return branches.trim().length > 0
  }

  it('pushes only its own settings branch (deploymentName default: prod)', async () => {
    await seedBranchInRemoteGit('canopycms-settings-prod', '{"acls":[]}')

    const worker = makeSettingsWorker() // no deploymentName -> defaults to 'prod'
    const git = simpleGit({ baseDir: remoteGitPath })
    await (worker as unknown as PushSettingsBranchesInternals).pushSettingsBranches(git, new Set())

    expect(await fixtureHasBranch('canopycms-settings-prod')).toBe(true)
    expect(consoleSpy).toHaveLogged('Pushed settings branch canopycms-settings-prod')
  })

  it('pushes the deployment-namespaced branch matching config.deploymentName, not a differently-named one', async () => {
    await seedBranchInRemoteGit('canopycms-settings-acme', '{"acls":[]}')

    const worker = makeSettingsWorker('acme')
    const git = simpleGit({ baseDir: remoteGitPath })
    await (worker as unknown as PushSettingsBranchesInternals).pushSettingsBranches(git, new Set())

    expect(await fixtureHasBranch('canopycms-settings-acme')).toBe(true)
  })

  it('does NOT push a foreign canopycms-settings-* branch, and warns about it once, naming it', async () => {
    await seedBranchInRemoteGit('canopycms-settings-acme', '{"acls":["mine"]}')
    await seedBranchInRemoteGit('canopycms-settings-other-tenant', '{"acls":["not mine"]}')

    const worker = makeSettingsWorker('acme')
    const git = simpleGit({ baseDir: remoteGitPath })
    // The foreign branch is present on GitHub, which is how it came to exist
    // locally at all (reconcileTrackedBranches creates heads from tracking
    // refs) -- i.e. the SUPPORTED two-deployments-one-repo case.
    await (worker as unknown as PushSettingsBranchesInternals).pushSettingsBranches(
      git,
      new Set(['canopycms-settings-other-tenant']),
    )

    expect(await fixtureHasBranch('canopycms-settings-acme')).toBe(true)
    expect(await fixtureHasBranch('canopycms-settings-other-tenant')).toBe(false)
    expect(consoleSpy).toHaveWarned('canopycms-settings-other-tenant')
    expect(consoleSpy).toHaveWarned('canopycms-settings-acme') // names this deployment's own branch too
    // ...and must NOT be reported as a deploymentName mismatch: this is the
    // supported shape, not the silent-settings-failure one.
    expect(consoleSpy).not.toHaveWarned('Settings branch mismatch')
  })

  it('resolves its settings branch through resolveDeploymentName (env > config > prod) and validates it', async () => {
    // The worker used to do its own `config.deploymentName ?? 'prod'`, which
    // skipped both the env var the infrastructure stamps and the ref-name
    // validation -- so it could silently own a different settings branch than
    // the API writing into the same workspace.
    // Drives the lazy resolver rather than reading a constructor-assigned
    // field: resolution moved into ensureSettingsBranch() so that an invalid
    // name throws somewhere start()'s catch can record it (see the next test).
    const settingsBranchOf = (worker: CmsWorker) =>
      (worker as unknown as { ensureSettingsBranch(): string }).ensureSettingsBranch()

    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
    expect(settingsBranchOf(makeSettingsWorker('from-config'))).toBe(
      'canopycms-settings-from-config',
    )
    expect(
      settingsBranchOf(
        new CmsWorker({
          workspacePath,
          githubOwner: 'o',
          githubRepo: 'r',
          githubToken: 't',
        }),
      ),
    ).toBe('canopycms-settings-prod')

    // Infra-stamped env wins over the shared repo's config, by design.
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'from-env')
    expect(settingsBranchOf(makeSettingsWorker('from-config'))).toBe('canopycms-settings-from-env')

    // A stamped value that is not a usable git ref component still fails
    // loudly rather than producing a broken branch name -- but at RESOLUTION,
    // not at construction. See the next test for why that distinction is the
    // whole point.
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'bad/name')
    expect(() => settingsBranchOf(makeSettingsWorker('from-config'))).toThrow(
      /invalid deploymentName/i,
    )

    vi.unstubAllEnvs()
  })

  it('surfaces an invalid deploymentName as a startup fatal error instead of an invisible crash-loop', async () => {
    // #198's constructor throw was credited with being "a loud startup exit".
    // It was not. `lastFatalError` is written ONLY by start()'s catch, and the
    // AWS entrypoint constructs the worker (canopycms-cdk/worker/index.ts:85)
    // before it calls start() (:119) -- so the throw happened where nothing
    // could record it. With systemd Type=simple + Restart=always and no
    // cfn-signal, the operator saw: `cdk deploy` reporting success, and an
    // admin panel showing the worker 'absent' with no fatal error, while the
    // process crash-looped every ~5 seconds.
    vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'bad/name')
    const consoleSpy = mockConsole()
    try {
      // 1. Construction must NOT throw -- this is the regression guard. If it
      //    does, everything below is unreachable in production too.
      const worker = makeSettingsWorker('from-config')

      // 2. start() surfaces it: throws for systemd, AND records it where the
      //    admin panel reads.
      await expect(worker.start()).rejects.toThrow(/invalid deploymentName/i)

      const status = JSON.parse(
        await fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8'),
      ) as WorkerStatusReport
      expect(status.lastFatalError?.phase).toBe('startup')
      expect(status.lastFatalError?.message).toMatch(/invalid deploymentName/i)
      expect(status.lastFatalError?.message).toContain('bad/name')

      // 3. The lock must not be left held: systemd restarts immediately, and a
      //    still-held lock would turn one config error into ELOCKED for up to
      //    lockStaleMs on every retry. start()'s catch releases before
      //    rethrowing; assert the file is actually gone rather than trusting it.
      await expect(fs.access(path.join(workspacePath, '.tasks', '.worker-lock'))).rejects.toThrow()
    } finally {
      consoleSpy.restore()
      vi.unstubAllEnvs()
    }
  })

  it('reports a deploymentName mismatch when a settings branch was pushed here locally but never reached GitHub', async () => {
    // The API resolved 'staging' and committed settings to
    // canopycms-settings-staging in remote.git; this worker resolved 'prod',
    // so it owns a branch that does not exist. Nothing pushes the real
    // branch onward -- the silent failure this check exists to surface.
    await seedBranchInRemoteGit('canopycms-settings-staging', '{"acls":["real settings"]}')

    const worker = makeSettingsWorker('prod')
    const git = simpleGit({ baseDir: remoteGitPath })
    // Empty tracking set: the branch is NOT on GitHub, so it can only have
    // been pushed into remote.git by this deployment's own API.
    await (worker as unknown as PushSettingsBranchesInternals).pushSettingsBranches(git, new Set())

    expect(consoleSpy).toHaveWarned('Settings branch mismatch')
    expect(consoleSpy).toHaveWarned('canopycms-settings-staging')
    expect(consoleSpy).toHaveWarned('settings changes are NOT reaching GitHub')
    // Still never pushes a branch it does not own.
    expect(await fixtureHasBranch('canopycms-settings-staging')).toBe(false)
  })

  it('skips quietly (no error) when this deployment has no settings branch locally yet', async () => {
    // Nothing seeded at all - remote.git has no canopycms-settings-* branches.
    const worker = makeSettingsWorker('acme')
    const git = simpleGit({ baseDir: remoteGitPath })

    await expect(
      (worker as unknown as PushSettingsBranchesInternals).pushSettingsBranches(git, new Set()),
    ).resolves.toBeUndefined()
    expect(await fixtureHasBranch('canopycms-settings-acme')).toBe(false)
  })

  it('warns explicitly that another deployment owns this settings branch on a real non-fast-forward rejection', async () => {
    // This deployment has its OWN local canopycms-settings-acme...
    await seedBranchInRemoteGit('canopycms-settings-acme', '{"acls":["mine"]}')

    // ...but another deployment already pushed a DIFFERENT settings branch of
    // the SAME name directly to GitHub -- an actual settings-branch name
    // collision, not just the "foreign branch found locally" case covered by
    // the test above.
    const foreignPath = path.join(tmpDir, 'seed-foreign-settings')
    await fs.mkdir(foreignPath, { recursive: true })
    const foreignGit = await initTestRepo(foreignPath)
    await foreignGit.raw(['checkout', '--orphan', 'canopycms-settings-acme'])
    await fs.writeFile(path.join(foreignPath, 'permissions.json'), '{"acls":["foreign"]}')
    await foreignGit.add(['permissions.json'])
    await foreignGit.commit('foreign deployment settings')
    await foreignGit.addRemote('origin', githubFixture)
    await foreignGit.raw(['push', 'origin', 'canopycms-settings-acme:canopycms-settings-acme'])

    const worker = makeSettingsWorker('acme')
    const git = simpleGit({ baseDir: remoteGitPath })
    await (worker as unknown as PushSettingsBranchesInternals).pushSettingsBranches(git, new Set())

    expect(consoleSpy).toHaveWarned(
      'another CanopyCMS deployment appears to own this settings branch',
    )
    expect(consoleSpy).toHaveWarned('canopycms-settings-acme')
    // The foreign deployment's push must survive untouched -- this
    // deployment's rejected push must not have force-overwritten it.
    const fixtureGit = simpleGit({ baseDir: githubFixture, config: ['safe.bareRepository=all'] })
    const remoteLog = await fixtureGit.raw(['log', 'canopycms-settings-acme', '--format=%s'])
    expect(remoteLog).toContain('foreign deployment settings')
    expect(remoteLog).not.toContain('seed settings')
  })
})
