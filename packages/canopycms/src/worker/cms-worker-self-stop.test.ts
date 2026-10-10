/**
 * A worker that stops for a reason of its own, and a worker that never started: each leaves
 * worker-status.json saying why, written under the worker lock, and a self-stopped worker
 * settles `selfStopped` so its entrypoint can exit and be restarted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import lockfile from 'proper-lockfile'

import { CmsWorker, recordWorkerStartupFailure, type WorkerSelfStop } from './cms-worker'
import { readWorkerStartupFailure, WORKER_STATUS_FILE } from '../task-queue/worker-status'
import { mockConsole, type MockConsole } from '../test-utils'
import type { BaseSchemaHold, WorkerStatusReport } from '../types'

type LockInternals = {
  running: boolean
  acquireLock(): Promise<void>
  trackOperation(label: string, operation: Promise<void>): Promise<void>
  shutdownController: AbortController
}

const internals = (worker: CmsWorker) => worker as unknown as LockInternals

const LOCK_STALE_MS = 2000

/** Settles with `selfStopped`'s value, or `'pending'` if it has not settled within `ms`. */
const settledWithin = (worker: CmsWorker, ms: number): Promise<WorkerSelfStop | 'pending'> =>
  Promise.race([
    worker.selfStopped,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ])

describe('CmsWorker.selfStopped', () => {
  let tmpDir: string
  let taskDir: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-self-stop-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const makeWorker = () =>
    new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      drainDeadlineMs: 60_000,
      lockStaleMs: LOCK_STALE_MS,
    })

  const readStatus = async (): Promise<WorkerStatusReport | null> => {
    try {
      return JSON.parse(await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8'))
    } catch {
      return null
    }
  }

  /** In flight until the drain aborts it, like a git command killed by the shutdown signal. */
  const trackAbortable = (worker: CmsWorker) => {
    const w = internals(worker)
    const { signal } = w.shutdownController
    void w.trackOperation(
      'task queue',
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
    )
  }

  it('settles after a lost heartbeat, recording why under the retaken lock', async () => {
    const worker = makeWorker()
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    trackAbortable(worker)

    // The heartbeat's next refresh finds the lock gone.
    await fs.rm(path.join(taskDir, '.worker-lock'), { recursive: true, force: true })

    expect(await settledWithin(worker, 5000)).toEqual({
      reason: 'the worker lost its lock on the shared workspace',
    })
    const status = await readStatus()
    expect(status?.lastFatalError).toMatchObject({ phase: 'run' })
    expect(status?.lastFatalError?.message).toContain('lost its lock on the shared workspace')
    expect(status?.lastShutdown).toMatchObject({
      reason: 'the worker lost its lock on the shared workspace',
      workerStartedAt: status?.startedAt,
    })
    // Released once recorded, so the restarted worker takes it at once.
    const release = await lockfile.lock(taskDir, {
      lockfilePath: path.join(taskDir, '.worker-lock'),
      stale: LOCK_STALE_MS,
    })
    await release()
  })

  /**
   * Age the held lock so the heartbeat's next refresh, within a second, finds an mtime that is
   * not its own. A second short of `lockStaleMs`: the youngest a refresh failure past the
   * threshold leaves it, so the retake has the longest wait it can need.
   */
  const ageHeldLock = async () => {
    const aged = new Date(Date.now() - (LOCK_STALE_MS - 1000))
    await fs.utimes(path.join(taskDir, '.worker-lock'), aged, aged)
  }

  it('retakes its own abandoned lock to record the loss', async () => {
    const worker = makeWorker()
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    trackAbortable(worker)

    await ageHeldLock()

    expect(await settledWithin(worker, 15_000)).toEqual({
      reason: 'the worker lost its lock on the shared workspace',
    })
    expect((await readStatus())?.lastFatalError?.phase).toBe('run')
  }, 25_000)

  it('records nothing over a status file another worker wrote during the wait', async () => {
    const worker = makeWorker()
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    trackAbortable(worker)

    await ageHeldLock()
    const successor = { version: 1, startedAt: '2026-10-09T10:00:00.000Z', updatedAt: 'x' }
    await fs.writeFile(path.join(taskDir, WORKER_STATUS_FILE), JSON.stringify(successor))

    expect(await settledWithin(worker, 15_000)).not.toBe('pending')
    expect(await readStatus()).toEqual(successor)
    expect(consoleSpy).toHaveErrored('another worker has written worker-status.json since')
  }, 25_000)

  it('writes nothing while a worker that took the lock over keeps it fresh', async () => {
    const worker = makeWorker()
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    trackAbortable(worker)

    // The successor is another process, so it is a lock dir whose heartbeat stays fresh: a
    // second proper-lockfile lock in this process would share the worker's entry in its lock
    // table and stop the worker's own heartbeat instead.
    const lockPath = path.join(taskDir, '.worker-lock')
    await fs.rm(lockPath, { recursive: true, force: true })
    await fs.mkdir(lockPath)
    const heartbeat = setInterval(() => {
      const now = new Date()
      void fs.utimes(lockPath, now, now).catch(() => {})
    }, 100)
    try {
      expect(await settledWithin(worker, 15_000)).toEqual({
        reason: 'the worker lost its lock on the shared workspace',
      })
      expect(await readStatus()).toBeNull()
      expect(consoleSpy).toHaveErrored('Not recording the lock loss')
    } finally {
      clearInterval(heartbeat)
    }
  }, 25_000)

  // On EFS a live successor's heartbeat can look older than it is (its refresh interval plus the
  // attribute cache), so the retake must not treat a lock just past `lockStaleMs` as abandoned.
  it("leaves a successor's lock alone while it looks only just stale", async () => {
    const worker = makeWorker()
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    trackAbortable(worker)

    const lockPath = path.join(taskDir, '.worker-lock')
    await fs.rm(lockPath, { recursive: true, force: true })
    await fs.mkdir(lockPath)
    const lookOld = () => {
      const seen = new Date(Date.now() - LOCK_STALE_MS * 1.25)
      return fs.utimes(lockPath, seen, seen).catch(() => {})
    }
    await lookOld()
    const lagging = setInterval(() => void lookOld(), 100)
    try {
      expect(await settledWithin(worker, 15_000)).toEqual({
        reason: 'the worker lost its lock on the shared workspace',
      })
      expect(await readStatus()).toBeNull()
      await expect(fs.stat(lockPath)).resolves.toBeTruthy()
    } finally {
      clearInterval(lagging)
    }
  }, 25_000)

  it('never settles for a stop the entrypoint asked for, even if the lock is lost during it', async () => {
    const worker = makeWorker()
    const w = internals(worker)
    await w.acquireLock()
    w.running = true
    let finish!: () => void
    void w.trackOperation('task queue', new Promise<void>((resolve) => (finish = resolve)))

    const stopping = worker.stop({ reason: 'SIGTERM' })
    await fs.rm(path.join(taskDir, '.worker-lock'), { recursive: true, force: true })
    // The heartbeat notices at its next refresh, up to half of LOCK_STALE_MS away.
    await expect
      .poll(() => consoleSpy.all().error.some((line) => line.includes('Worker lock compromised')), {
        timeout: 5000,
      })
      .toBe(true)
    finish()
    await stopping

    expect(await settledWithin(worker, 200)).toBe('pending')
  })
})

describe('recordWorkerStartupFailure', () => {
  let tmpDir: string
  let taskDir: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-startup-failure-'))
    taskDir = path.join(tmpDir, '.tasks')
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const baseHold: BaseSchemaHold = {
    since: '2026-10-09T09:00:00.000Z',
    firstSeen: { article: '2026-10-09T09:00:00.000Z' },
    incomingSha: 'abc123',
    missingSchemas: ['article'],
    files: ['content/posts/.collection.json'],
    fileCount: 1,
    editorBuild: { canopycmsVersion: '0.0.0-test' },
    editorRecordedAt: '2026-10-09T08:00:00.000Z',
  }

  it('records a redacted startup failure, carrying the previous shutdown and schema hold', async () => {
    await fs.mkdir(taskDir, { recursive: true })
    const lastShutdown = {
      reason: 'SIGTERM',
      at: '2026-10-09T09:30:00.000Z',
      workerStartedAt: '2026-10-09T08:00:00.000Z',
      outcome: 'drained' as const,
    }
    await fs.writeFile(
      path.join(taskDir, WORKER_STATUS_FILE),
      JSON.stringify({
        version: 1,
        startedAt: '2026-10-09T08:00:00.000Z',
        updatedAt: '2026-10-09T09:30:00.000Z',
        lastGitSyncAt: '2026-10-09T09:25:00.000Z',
        lastShutdown,
        baseHold,
      }),
    )

    await recordWorkerStartupFailure({
      workspacePath: tmpDir,
      error: new Error('Secret read failed for https://ghp_abcdefghijklmnop@github.com'),
      lockStaleMs: LOCK_STALE_MS,
    })

    const status: WorkerStatusReport = JSON.parse(
      await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8'),
    )
    expect(status.lastFatalError?.phase).toBe('startup')
    expect(status.lastFatalError?.message).toContain('Secret read failed')
    expect(status.lastFatalError?.message).not.toContain('ghp_abcdefghijklmnop')
    expect(status.lastShutdown).toEqual(lastShutdown)
    expect(status.baseHold).toEqual(baseHold)
    expect(status.lastGitSyncAt).toBeUndefined()
    // The API's not-ready answer reads it as the latest attempt's failure.
    expect((await readWorkerStartupFailure(taskDir))?.current).toBe(true)
    // And the lock is free again.
    await expect(fs.access(path.join(taskDir, '.worker-lock'))).rejects.toThrow()
  })

  it("leaves a lock alone that looks only just stale, since a live holder's can", async () => {
    await fs.mkdir(taskDir, { recursive: true })
    const lockPath = path.join(taskDir, '.worker-lock')
    await fs.mkdir(lockPath)
    const seen = new Date(Date.now() - LOCK_STALE_MS * 1.25)
    await fs.utimes(lockPath, seen, seen)

    await recordWorkerStartupFailure({
      workspacePath: tmpDir,
      error: new Error('boom'),
      lockStaleMs: LOCK_STALE_MS,
    })

    await expect(fs.access(path.join(taskDir, WORKER_STATUS_FILE))).rejects.toThrow()
    await expect(fs.stat(lockPath)).resolves.toBeTruthy()
  })

  it('writes nothing while another worker holds the lock', async () => {
    await fs.mkdir(taskDir, { recursive: true })
    const release = await lockfile.lock(taskDir, {
      lockfilePath: path.join(taskDir, '.worker-lock'),
      stale: LOCK_STALE_MS,
    })
    try {
      await recordWorkerStartupFailure({
        workspacePath: tmpDir,
        error: new Error('boom'),
        lockStaleMs: LOCK_STALE_MS,
      })
    } finally {
      await release()
    }

    await expect(fs.access(path.join(taskDir, WORKER_STATUS_FILE))).rejects.toThrow()
    expect(consoleSpy).toHaveErrored('another worker holds the lock')
  })
})
