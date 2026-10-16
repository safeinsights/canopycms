/**
 * worker-status.json: the CmsWorker daemon's self-reported liveness/health
 * snapshot, written under the task queue directory
 * (`{taskDir}/worker-status.json`) and read tolerantly by the admin API
 * (api/admin.ts's `readWorkerStatus`). Wire shape: `WorkerStatusReport` in
 * ../types.
 *
 * Single-writer by intent (only the lock-holding CmsWorker -- see
 * cms-worker.ts's `acquireLock`, DEP-C2), but correctness does not rest on
 * that: every write is a FULL regeneration landed by an atomic temp-file rename
 * (utils/atomic-write.ts), never a read-modify-write, so whichever write lands
 * last is one writer's complete, self-consistent snapshot. That covers the one
 * window where two holders overlap -- after a lock compromise the old holder's
 * `stop()` aborts its in-flight work while a new holder may already be
 * running against the same workspace.
 *
 * Readers are stale-tolerant by design: this is a liveness signal, not
 * authoritative state, and NFS/EFS attribute-cache staleness (see
 * docs/concurrency.md) means a reader can see a snapshot a cache window old
 * however carefully it was written.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteFile } from '../utils/atomic-write'
import { isNotFoundError } from '../utils/error'
import type { WorkerStatusReport } from '../types'

export const WORKER_STATUS_FILE = 'worker-status.json'

/**
 * What a new worker carries from the previous status file into its first snapshot:
 * `lastFatalError`, so a crash loop keeps its alert, and how the last worker that ran stopped.
 * A `lastShutdown` written by an earlier worker than the file's own means the last one stopped
 * without draining, unless the file's own worker recorded its failed start: it never ran, so the
 * carried record holds. Tolerant like every reader: a missing or unreadable file yields neither.
 */
export async function readCarriedOverStatus(
  taskDir: string,
): Promise<Pick<WorkerStatusReport, 'lastFatalError' | 'lastShutdown'>> {
  let previous: Partial<WorkerStatusReport>
  try {
    const content = await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8')
    previous = JSON.parse(content) as Partial<WorkerStatusReport>
  } catch {
    return {}
  }
  const { lastFatalError, startedAt, updatedAt } = previous
  let { lastShutdown } = previous
  const failedStart =
    lastFatalError?.phase === 'startup' && lastFatalError.workerStartedAt === startedAt
  if (startedAt && updatedAt && !failedStart && lastShutdown?.workerStartedAt !== startedAt) {
    lastShutdown = {
      reason: 'stopped without draining',
      at: updatedAt,
      workerStartedAt: startedAt,
      outcome: 'not-drained',
    }
  }
  return { lastFatalError, lastShutdown }
}

/**
 * `startedAt` of the worker that wrote the status file, or `undefined` when there is no file or
 * it names no worker. Throws on any other read error: a caller deciding whether the file is its
 * own must not take an unreadable one for an absent one.
 */
export async function readWorkerStatusStartedAt(taskDir: string): Promise<string | undefined> {
  let content: string
  try {
    content = await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8')
  } catch (err) {
    if (isNotFoundError(err)) return undefined
    throw err
  }
  try {
    const report = JSON.parse(content) as Partial<WorkerStatusReport>
    return typeof report.startedAt === 'string' ? report.startedAt : undefined
  } catch {
    return undefined
  }
}

/** A startup failure the worker recorded; see {@link readWorkerStartupFailure}. */
export interface WorkerStartupFailure {
  /** Already redacted by the worker. */
  message: string
  at: string
  /**
   * The attempt that wrote the file is the one that failed. False while a newer worker carries
   * an older failure forward and is starting again.
   */
  current: boolean
}

/**
 * The startup failure in `{taskDir}/worker-status.json`, for a request that found no remote to
 * clone. A failure is current when the worker that recorded it is the one the snapshot
 * describes: a worker that starts again writes its own `startedAt` and carries the previous
 * failure forward, so a retry in progress (a first clone can take minutes) is not reported as a
 * dead worker. Compared by identity, not by clock, since the two workers can run on different
 * hosts. Tolerant like every reader: a missing or unreadable file yields none.
 */
export async function readWorkerStartupFailure(
  taskDir: string,
): Promise<WorkerStartupFailure | undefined> {
  let report: Partial<WorkerStatusReport>
  try {
    report = JSON.parse(
      await fs.readFile(path.join(taskDir, WORKER_STATUS_FILE), 'utf-8'),
    ) as Partial<WorkerStatusReport>
  } catch {
    return undefined
  }
  const fatal = report.lastFatalError
  if (fatal?.phase !== 'startup' || typeof fatal.message !== 'string') return undefined
  let current: boolean
  if (fatal.workerStartedAt !== undefined) {
    current = fatal.workerStartedAt === report.startedAt
  } else {
    // A file from a worker that does not link the two: compare clocks instead.
    const startedAt = report.startedAt ? Date.parse(report.startedAt) : NaN
    current = Number.isNaN(startedAt) || !(Date.parse(fatal.at) < startedAt)
  }
  return { message: fatal.message, at: fatal.at, current }
}

/**
 * Write the worker's status report to `{taskDir}/worker-status.json`.
 *
 * Full-file regeneration, never a partial update: pass the complete report,
 * not a delta. Stamps `updatedAt`; every other field is the caller's.
 *
 * Throws rather than swallowing. Callers that cannot let a status-write failure
 * break their own operation wrap this at the call site (`syncGit`,
 * `processTaskQueue`, `start()`); any that don't fall back on scheduleLoop's
 * per-cycle catch, which logs and continues.
 */
export async function writeWorkerStatus(
  taskDir: string,
  report: WorkerStatusReport,
): Promise<void> {
  const filePath = path.join(taskDir, WORKER_STATUS_FILE)
  const stamped: WorkerStatusReport = { ...report, updatedAt: new Date().toISOString() }
  await atomicWriteFile(filePath, JSON.stringify(stamped, null, 2))
}
