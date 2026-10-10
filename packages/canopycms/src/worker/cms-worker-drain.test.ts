/**
 * `CmsWorker.stop()` as a drain: what a worker being replaced does with the
 * work it holds. It claims nothing new, lets in-flight work finish within the
 * drain deadline, aborts what is still running at the deadline (a task is
 * released to pending with no retry spent, its git push killed), stops the
 * sync loop at a stage or branch boundary, and records why it stopped in
 * worker-status.json, which the next worker carries forward.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'

import { CmsWorker } from './cms-worker'
import { enqueueTask } from '../task-queue/cms-task-queue'
import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { initTestRepo, mockConsole, type MockConsole } from '../test-utils'
import type { Task } from '../task-queue/cms-task-queue'
import type { WorkerStatusReport } from '../types'

type DrainInternals = {
  running: boolean
  acquireLock(): Promise<void>
  trackOperation(label: string, operation: Promise<void>): Promise<void>
  executeTask(task: Task, signal: AbortSignal): Promise<Record<string, unknown>>
  pushBranchToGitHub(branch: string, signal?: AbortSignal): Promise<void>
  buildGitHubUrl(): Promise<string>
}

const internals = (worker: CmsWorker) => worker as unknown as DrainInternals

/** Wait for `predicate`, or give up — so a failure reads as a timeout, not a hang. */
const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate()
}

const readTaskFile = async (taskDir: string, status: string, id: string): Promise<Task | null> => {
  try {
    return JSON.parse(await fs.readFile(path.join(taskDir, status, `${id}.json`), 'utf-8'))
  } catch {
    return null
  }
}

describe('CmsWorker.stop() drains the task queue', () => {
  let tmpDir: string
  let taskDir: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-drain-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeWorker = (drainDeadlineMs: number) =>
    new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 10_000,
      drainDeadlineMs,
    })

  it('finishes the task it holds and claims no other', async () => {
    const worker = makeWorker(5_000)
    const w = internals(worker)
    w.running = true
    let finishFirst!: () => void
    const executed: string[] = []
    w.executeTask = async (task) => {
      executed.push(task.id)
      if (executed.length === 1) await new Promise<void>((r) => (finishFirst = r))
      return { pushed: true }
    }

    // Both tasks get one `createdAt`, so the queue breaks the tie by random id
    // and either may be claimed first.
    vi.useFakeTimers({ toFake: ['Date'] })
    let ids: string[]
    try {
      ids = [
        await enqueueTask(taskDir, { action: 'push-branch', payload: { branch: 'a' } }),
        await enqueueTask(taskDir, { action: 'push-branch', payload: { branch: 'b' } }),
      ]
    } finally {
      vi.useRealTimers()
    }

    void w.trackOperation('task queue', worker.processTaskQueue())
    expect(await waitFor(() => executed.length === 1)).toBe(true)

    const stopping = worker.stop({ reason: 'test' })
    finishFirst()
    await stopping

    expect(executed).toHaveLength(1)
    const [claimed] = executed
    const other = ids.find((id) => id !== claimed)!
    expect(ids).toContain(claimed)
    expect((await readTaskFile(taskDir, 'completed', claimed))?.status).toBe('completed')
    expect((await readTaskFile(taskDir, 'pending', other))?.status).toBe('pending')
  })

  it('at the deadline, aborts the in-flight task and releases it to pending with no retry spent', async () => {
    const worker = makeWorker(200)
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    let seenSignal: AbortSignal | undefined
    // Ignores its signal, like a git process that never exits on its own.
    w.executeTask = (_task, signal) => {
      seenSignal = signal
      return new Promise(() => {})
    }

    const id = await enqueueTask(taskDir, { action: 'push-branch', payload: { branch: 'a' } })
    void w.trackOperation('task queue', worker.processTaskQueue())
    expect(await waitFor(() => seenSignal !== undefined)).toBe(true)

    const started = Date.now()
    await worker.stop({ reason: 'test shutdown' })
    expect(Date.now() - started).toBeLessThan(3000)

    expect(seenSignal?.aborted).toBe(true)
    const released = await readTaskFile(taskDir, 'pending', id)
    expect(released?.status).toBe('pending')
    expect(released?.retryCount ?? 0).toBe(0)
    expect(released?.retryAfter).toBeUndefined()
    expect(await readTaskFile(taskDir, 'processing', id)).toBeNull()
    expect(consoleSpy).toHaveWarned('released to pending for the next worker')

    const status: WorkerStatusReport = JSON.parse(
      await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8'),
    )
    expect(status.lastShutdown).toMatchObject({
      reason: 'test shutdown',
      outcome: 'deadline',
      abandoned: ['task queue'],
    })

    // The lock was released last, so a successor can take it now.
    const successor = makeWorker(200)
    await internals(successor).acquireLock()
    await successor.stop()
  })

  it('aborts at once, with no drain, when the worker lock is compromised', async () => {
    const worker = new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      drainDeadlineMs: 60_000,
      lockStaleMs: 2000,
    })
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    void w.trackOperation('task queue', new Promise<void>(() => {}))

    // The heartbeat's next refresh finds the lock gone.
    await fs.rm(path.join(taskDir, '.worker-lock'), { recursive: true, force: true })

    expect(
      await waitFor(
        () => consoleSpy.all().warn.some((line) => line.includes('Drain deadline (0s) hit')),
        5000,
      ),
    ).toBe(true)
  })

  it('a compromise during a drain already under way aborts it at once', async () => {
    const worker = makeWorker(60_000)
    void internals(worker).trackOperation('task queue', new Promise<void>(() => {}))
    const signal = (worker as unknown as { shutdownController: AbortController }).shutdownController
      .signal

    void worker.stop({ reason: 'SIGTERM' })
    expect(signal.aborted).toBe(false)
    void worker.stop({ reason: 'worker lock compromised', deadlineMs: 0 })
    expect(signal.aborted).toBe(true)
  })

  it('start() after a finished stop() takes no lock', async () => {
    const worker = makeWorker(200)
    await worker.stop({ reason: 'SIGTERM' })
    await worker.start()

    const successor = makeWorker(200)
    await internals(successor).acquireLock()
    await successor.stop()
  })

  it('returns the same drain to a second caller', async () => {
    const worker = makeWorker(200)
    const first = worker.stop({ reason: 'SIGTERM' })
    const second = worker.stop({ reason: 'lock compromised' })
    expect(second).toBe(first)
    await first
    expect(consoleSpy).toHaveLogged('Draining (SIGTERM)')
    expect(consoleSpy).not.toHaveLogged('lock compromised')
  })
})

describe("CmsWorker.stop() kills an aborted task's git push", () => {
  let tmpDir: string
  let remoteGitPath: string
  let githubFixture: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-drain-push-'))
    remoteGitPath = path.join(tmpDir, 'workspace', 'remote.git')
    githubFixture = path.join(tmpDir, 'fixture-github.git')
    await simpleGit().raw(['init', '--bare', remoteGitPath])
    await simpleGit().raw(['init', '--bare', githubFixture])

    // A push to the fixture blocks in its pre-receive hook, as a slow upload
    // to GitHub would, so it is still running when the signal aborts.
    const hook = path.join(githubFixture, 'hooks', 'pre-receive')
    await fs.writeFile(hook, '#!/bin/sh\ntouch receiving\nsleep 3\nexit 1\n')
    await fs.chmod(hook, 0o755)

    const seedPath = path.join(tmpDir, 'seed')
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await fs.writeFile(path.join(seedPath, 'file.txt'), 'hello')
    await seedGit.add(['file.txt'])
    await seedGit.commit('seed')
    await seedGit.raw(['push', remoteGitPath, 'HEAD:refs/heads/feature'])
  })

  afterEach(async () => {
    consoleSpy.restore()
    // An aborted push leaves the fixture's receive-pack, and its 3s hook, still writing there.
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 })
  })

  it('a submit whose push the drain aborts is released, not stamped as pushed, and stays submitted', async () => {
    const workspacePath = path.join(tmpDir, 'workspace')
    const contentBranchesPath = path.join(workspacePath, 'content-branches')
    const branchPath = path.join(contentBranchesPath, 'feature')
    await fs.mkdir(branchPath, { recursive: true })
    const meta = getBranchMetadataFileManager(branchPath, contentBranchesPath)
    const submittedAt = '2026-10-09T00:00:00.000Z'
    await meta.save({ branch: { name: 'feature', status: 'submitted', submittedAt } })

    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskTimeoutMs: 10_000,
      drainDeadlineMs: 300,
    })
    const w = internals(worker)
    w.buildGitHubUrl = async () => githubFixture
    await w.acquireLock()
    w.running = true
    const taskDir = path.join(workspacePath, '.tasks')
    const id = await enqueueTask(taskDir, {
      action: 'push-and-create-or-update-pr',
      payload: { branch: 'feature', submittedAt },
    })

    void w.trackOperation('task queue', worker.processTaskQueue())
    // The push is under way once the fixture's hook has started.
    const receiving = path.join(githubFixture, 'receiving')
    for (let i = 0; i < 300 && !(await fs.stat(receiving).catch(() => null)); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    await fs.stat(receiving)
    await worker.stop({ reason: 'SIGTERM' })

    const released = await readTaskFile(taskDir, 'pending', id)
    expect(released?.retryCount ?? 0).toBe(0)
    const branch = (await BranchMetadataFileManager.loadOnly(branchPath))!.branch
    expect(branch.pushedToGitHubAt).toBeUndefined()
    expect(branch.status).toBe('submitted')
    expect(branch.syncFailureReason).toBeUndefined()
  })

  it('rejects with the abort as soon as the signal fires, not when git would have finished', async () => {
    const worker = new CmsWorker({
      workspacePath: path.join(tmpDir, 'workspace'),
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
    })
    const w = internals(worker)
    w.buildGitHubUrl = async () => githubFixture

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    await expect(w.pushBranchToGitHub('feature', controller.signal)).rejects.toThrow(/[Aa]bort/)
    expect(Date.now() - started).toBeLessThan(2500)
  })
})

describe('CmsWorker.syncGit() while draining', () => {
  let tmpDir: string
  let workspacePath: string
  let fixtureRemote: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-drain-sync-'))
    workspacePath = path.join(tmpDir, 'workspace')
    fixtureRemote = path.join(tmpDir, 'fixture-github.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', path.join(workspacePath, 'remote.git')])

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
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const createSyncBranch = async (branchName: string) => {
    const branchPath = path.join(workspacePath, 'content-branches', branchName)
    await fs.mkdir(path.join(workspacePath, 'content-branches'), { recursive: true })
    await simpleGit().clone(fixtureRemote, branchPath, ['--branch', 'main', '--single-branch'])
    const branchGit = simpleGit({ baseDir: branchPath, unsafe: { allowUnsafeEditor: true } })
    await branchGit.addConfig('user.name', 'Test Bot')
    await branchGit.addConfig('user.email', 'test@canopycms.test')
    await branchGit.checkoutBranch(branchName, 'origin/main')
    await getBranchMetadataFileManager(
      branchPath,
      path.join(workspacePath, 'content-branches'),
    ).save({ branch: { name: branchName } })
    return branchGit
  }

  const advanceGitHubMain = async () => {
    const seedPath = path.join(tmpDir, 'fixture-seed')
    const seedGit = simpleGit({ baseDir: seedPath })
    await fs.writeFile(path.join(seedPath, 'remote-update.txt'), 'from GitHub')
    await seedGit.add(['.'])
    await seedGit.commit('advance main')
    await seedGit.push('origin', 'main')
  }

  const hasUpstreamCommit = async (branchGit: ReturnType<typeof simpleGit>) =>
    (await branchGit.raw(['log', '--format=%s'])).includes('advance main')

  /** Starts draining the instant the first branch's rebase succeeds. */
  class DrainMidCycleWorker extends CmsWorker {
    protected override async afterRebaseCompletedForTesting(): Promise<void> {
      void this.stop({ reason: 'test' })
    }
  }

  it('finishes the branch it is rebasing and starts no other', async () => {
    const one = await createSyncBranch('branch-one')
    const two = await createSyncBranch('branch-two')
    await advanceGitHubMain()

    const worker = new DrainMidCycleWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    internals(worker).buildGitHubUrl = async () => fixtureRemote
    internals(worker).running = true

    await worker.syncGit()

    const rebased = [await hasUpstreamCommit(one), await hasUpstreamCommit(two)]
    expect(rebased.filter(Boolean)).toHaveLength(1)
    expect(consoleSpy).toHaveLogged('Rebase cycle stopped: the worker is draining')
    expect(consoleSpy).toHaveLogged('Git sync stopped before the cleanup sweeps')
  })

  it('stops at the next stage boundary, leaving the previous cycle in worker-status.json', async () => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    // The drain begins while the GitHub fetch is under way.
    internals(worker).buildGitHubUrl = async () => {
      void worker.stop({ reason: 'test' })
      return fixtureRemote
    }
    internals(worker).running = true

    await worker.syncGit()

    expect(consoleSpy).toHaveLogged('Git sync stopped before the base-branch refresh')
    await expect(
      fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8'),
    ).rejects.toThrow()
  })

  it('kills its GitHub fetch once the drain deadline aborts', async () => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    internals(worker).buildGitHubUrl = async () => fixtureRemote
    internals(worker).running = true
    ;(worker as unknown as { shutdownController: AbortController }).shutdownController.abort()

    await expect(worker.syncGit()).rejects.toThrow(/[Aa]bort/)
  })
})

describe('lastShutdown across a worker replacement', () => {
  let tmpDir: string
  let workspacePath: string
  let githubFixture: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-drain-replace-'))
    workspacePath = path.join(tmpDir, 'workspace')
    githubFixture = path.join(tmpDir, 'fixture-github.git')
    await fs.mkdir(workspacePath, { recursive: true })
    await simpleGit().raw(['init', '--bare', path.join(workspacePath, 'remote.git')])
    await simpleGit().raw(['init', '--bare', githubFixture])
    const seedPath = path.join(tmpDir, 'seed')
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await fs.writeFile(path.join(seedPath, 'README.md'), 'seed')
    await seedGit.add(['README.md'])
    await seedGit.commit('seed')
    await seedGit.raw(['push', path.join(workspacePath, 'remote.git'), 'HEAD:refs/heads/main'])
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeWorker = () => {
    const worker = new CmsWorker({
      workspacePath,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      taskPollInterval: 10_000,
      gitSyncInterval: 10_000,
    })
    internals(worker).buildGitHubUrl = async () => githubFixture
    return worker
  }

  it('a stop during startup waits for it, then releases the lock', async () => {
    const old = makeWorker()
    let finishClone!: () => void
    let cloning = false
    ;(old as unknown as { ensureRemoteGit(): Promise<void> }).ensureRemoteGit = () =>
      new Promise<void>((resolve) => {
        cloning = true
        finishClone = resolve
      })

    const starting = old.start()
    expect(await waitFor(() => cloning)).toBe(true)
    let stopped = false
    const stopping = old.stop({ reason: 'SIGTERM' }).then(() => (stopped = true))
    await new Promise((r) => setTimeout(r, 100))
    expect(stopped).toBe(false)

    finishClone()
    await stopping
    await starting

    const successor = makeWorker()
    await internals(successor).acquireLock()
    await successor.stop()
    expect(consoleSpy).not.toHaveLogged('CMS Worker started')
  })

  it('a stop before the lock is taken leaves no lock behind once it resolves', async () => {
    const old = makeWorker()
    const starting = old.start()
    await old.stop({ reason: 'SIGTERM' })

    const successor = makeWorker()
    await internals(successor).acquireLock()
    await successor.stop()
    await starting
  })

  it("the successor starts once the old worker has drained, and reports the old worker's shutdown", async () => {
    const old = makeWorker()
    await old.start()
    await old.stop({ reason: 'SIGTERM' })

    const successor = makeWorker()
    try {
      await successor.start()
      const status: WorkerStatusReport = JSON.parse(
        await fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8'),
      )
      expect(status.lastShutdown).toMatchObject({ reason: 'SIGTERM', outcome: 'drained' })
      expect(status.lastShutdown?.abandoned).toBeUndefined()
    } finally {
      await successor.stop()
    }
  })
})
