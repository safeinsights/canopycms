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
import { enqueueTask } from './task-queue'
import { WORKER_STATUS_FILE } from './worker-status'
import { initTestRepo, mockConsole } from '../test-utils'
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
    graphql: ReturnType<typeof vi.fn>
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
