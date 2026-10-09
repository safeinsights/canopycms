/**
 * Unit tests for writeWorkerStatus() (PR-W1): full-file regeneration of
 * worker-status.json, the CmsWorker daemon's self-reported liveness/health
 * snapshot read by api/admin.ts's readWorkerStatus.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  readCarriedOverStatus,
  readWorkerStartupFailure,
  writeWorkerStatus,
  WORKER_STATUS_FILE,
} from './worker-status'
import type { WorkerStatusReport } from '../types'

describe('writeWorkerStatus', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-status-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const statusPath = () => path.join(tmpDir, WORKER_STATUS_FILE)

  it('writes to the expected filename and stamps updatedAt', async () => {
    const report: WorkerStatusReport = {
      version: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'stale-placeholder',
      lastTaskCycleAt: '2026-01-01T00:01:00.000Z',
    }

    await writeWorkerStatus(tmpDir, report)

    const parsed = JSON.parse(await fs.readFile(statusPath(), 'utf-8')) as WorkerStatusReport
    expect(parsed.version).toBe(1)
    expect(parsed.startedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed.lastTaskCycleAt).toBe('2026-01-01T00:01:00.000Z')
    // updatedAt is stamped by the write itself, not passed through verbatim.
    expect(parsed.updatedAt).not.toBe('stale-placeholder')
    expect(new Date(parsed.updatedAt).toString()).not.toBe('Invalid Date')
  })

  it('creates the task dir if it does not exist yet', async () => {
    const freshTaskDir = path.join(tmpDir, 'not-yet-created', '.tasks')
    const report: WorkerStatusReport = {
      version: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'x',
    }

    await writeWorkerStatus(freshTaskDir, report)

    await expect(fs.stat(path.join(freshTaskDir, WORKER_STATUS_FILE))).resolves.toBeTruthy()
  })

  it('fully replaces the file on a second write -- removed optional keys are gone (no merge)', async () => {
    const first: WorkerStatusReport = {
      version: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'x',
      lastGitSyncError: { message: 'boom', at: '2026-01-01T00:00:00.000Z' },
      lastFatalError: { message: 'dead', at: '2026-01-01T00:00:00.000Z', phase: 'startup' },
      lastGitSync: {
        durationMs: 10,
        rebased: ['a'],
        skippedDirty: [],
        failed: [],
        tracked: { created: [], fastForwarded: [], ahead: [], diverged: [] },
      },
    }
    await writeWorkerStatus(tmpDir, first)

    const second: WorkerStatusReport = {
      version: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'x',
      lastTaskCycleAt: '2026-01-01T00:02:00.000Z',
    }
    await writeWorkerStatus(tmpDir, second)

    const parsed = JSON.parse(await fs.readFile(statusPath(), 'utf-8')) as WorkerStatusReport
    expect(parsed.lastGitSyncError).toBeUndefined()
    expect(parsed.lastFatalError).toBeUndefined()
    expect(parsed.lastGitSync).toBeUndefined()
    expect(parsed.lastTaskCycleAt).toBe('2026-01-01T00:02:00.000Z')
  })
})

describe('readCarriedOverStatus', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-status-carry-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("returns the previous worker's fatal error and shutdown record, and nothing else", async () => {
    const lastFatalError = {
      message: 'dead',
      at: '2026-01-01T00:00:00.000Z',
      phase: 'run' as const,
    }
    const lastShutdown = {
      reason: 'SIGTERM',
      at: '2026-01-01T00:01:00.000Z',
      workerStartedAt: '2026-01-01T00:00:00.000Z',
      outcome: 'deadline' as const,
      drainMs: 90_000,
      abandoned: ['git sync'],
    }
    await writeWorkerStatus(tmpDir, {
      version: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'x',
      lastTaskCycleAt: '2026-01-01T00:00:30.000Z',
      lastFatalError,
      lastShutdown,
    })

    expect(await readCarriedOverStatus(tmpDir)).toEqual({ lastFatalError, lastShutdown })
  })

  it('reports a worker that stopped without recording a shutdown as not drained', async () => {
    // The file's writer started after the recorded shutdown's worker: it inherited
    // that record and then died without replacing it.
    await writeWorkerStatus(tmpDir, {
      version: 1,
      startedAt: '2026-01-02T00:00:00.000Z',
      updatedAt: 'x',
      lastShutdown: {
        reason: 'SIGTERM',
        at: '2026-01-01T00:01:00.000Z',
        workerStartedAt: '2026-01-01T00:00:00.000Z',
        outcome: 'drained',
        drainMs: 10,
      },
    })
    const written = JSON.parse(
      await fs.readFile(path.join(tmpDir, WORKER_STATUS_FILE), 'utf-8'),
    ) as WorkerStatusReport

    expect((await readCarriedOverStatus(tmpDir)).lastShutdown).toEqual({
      reason: 'stopped without draining',
      at: written.updatedAt,
      workerStartedAt: '2026-01-02T00:00:00.000Z',
      outcome: 'not-drained',
    })
  })

  it('reports not drained when the previous worker recorded no shutdown at all', async () => {
    await writeWorkerStatus(tmpDir, {
      version: 1,
      startedAt: '2026-01-02T00:00:00.000Z',
      updatedAt: 'x',
    })

    expect((await readCarriedOverStatus(tmpDir)).lastShutdown?.outcome).toBe('not-drained')
  })

  it('returns nothing when there is no readable status file', async () => {
    expect(await readCarriedOverStatus(tmpDir)).toEqual({})
    await fs.writeFile(path.join(tmpDir, WORKER_STATUS_FILE), '{not json')
    expect(await readCarriedOverStatus(tmpDir)).toEqual({})
  })
})

describe('readWorkerStartupFailure', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-startup-failure-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const write = (report: Partial<WorkerStatusReport>) =>
    fs.writeFile(path.join(tmpDir, WORKER_STATUS_FILE), JSON.stringify(report))

  it('is current when the snapshot that recorded it is the attempt that failed', async () => {
    await write({
      startedAt: '2026-10-09T10:00:00.000Z',
      lastFatalError: { message: 'boom', at: '2026-10-09T10:00:00.000Z', phase: 'startup' },
    })
    expect(await readWorkerStartupFailure(tmpDir)).toEqual({
      message: 'boom',
      at: '2026-10-09T10:00:00.000Z',
      current: true,
    })
  })

  it('is not current once a newer worker has carried it forward', async () => {
    await write({
      startedAt: '2026-10-09T10:00:05.000Z',
      lastFatalError: { message: 'boom', at: '2026-10-09T10:00:00.000Z', phase: 'startup' },
    })
    expect((await readWorkerStartupFailure(tmpDir))?.current).toBe(false)
  })

  it('ignores a failure while running, which a missing remote cannot follow', async () => {
    await write({
      startedAt: '2026-10-09T10:00:00.000Z',
      lastFatalError: { message: 'boom', at: '2026-10-09T10:01:00.000Z', phase: 'run' },
    })
    expect(await readWorkerStartupFailure(tmpDir)).toBeUndefined()
  })

  it('returns nothing when there is no readable status file', async () => {
    expect(await readWorkerStartupFailure(tmpDir)).toBeUndefined()
    await fs.writeFile(path.join(tmpDir, WORKER_STATUS_FILE), '{not json')
    expect(await readWorkerStartupFailure(tmpDir)).toBeUndefined()
  })
})
