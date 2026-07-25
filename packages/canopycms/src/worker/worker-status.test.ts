/**
 * Unit tests for writeWorkerStatus() (PR-W1): full-file regeneration of
 * worker-status.json, the CmsWorker daemon's self-reported liveness/health
 * snapshot read by api/admin.ts's readWorkerStatus.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { writeWorkerStatus, WORKER_STATUS_FILE } from './worker-status'
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
      lastGitSync: { durationMs: 10, rebased: ['a'], skippedDirty: [], failed: [] },
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
