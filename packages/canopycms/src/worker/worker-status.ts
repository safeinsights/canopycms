/**
 * worker-status.json: the CmsWorker daemon's self-reported liveness/health
 * snapshot (PR-W1), written under the task queue directory
 * (`{taskDir}/worker-status.json`, i.e. `.tasks/worker-status.json`) and
 * read tolerantly by the admin API (api/admin.ts's `readWorkerStatus`).
 * Wire shape: `WorkerStatusReport` in ../types.
 *
 * Single-writer file: only the lock-holding CmsWorker (see cms-worker.ts's
 * `acquireLock`, DEP-C2) ever writes it. Every write is a FULL regeneration
 * of the whole report, never a partial merge -- there is no read-modify-write
 * step, so last-write-wins is trivially correct: whichever write lands last
 * (via the atomic rename below) is a complete, self-consistent snapshot.
 * Readers (the Lambda admin endpoint, typically on a different host) are
 * stale-tolerant by design: this file is a liveness signal, not
 * authoritative state, and NFS/EFS attribute-cache staleness (see
 * docs/concurrency.md) means a reader can see a snapshot up to the cache
 * window old regardless of how carefully the write itself is done.
 *
 * Honest caveat: after a lock compromise (`onCompromised` in
 * `acquireLock`), the old holder's `stop()` drains in-flight operations for
 * up to `taskTimeoutMs` (default 60s) before the lock is actually released,
 * while a new holder may already be running against the same workspace. For
 * that window, both the old and new holder can call `writeWorkerStatus`
 * concurrently. This is harmless: every write is an atomic full-snapshot
 * rename (temp file + `rename()`, see utils/atomic-write.ts), never a
 * read-modify-write, so the result is always exactly one writer's complete
 * snapshot -- whichever lands last -- never a corrupt or interleaved mix of
 * both writers' data.
 */

import path from 'node:path'

import { atomicWriteFile } from '../utils/atomic-write'
import type { WorkerStatusReport } from '../types'

export const WORKER_STATUS_FILE = 'worker-status.json'

/**
 * Write the worker's status report to `{taskDir}/worker-status.json`.
 *
 * Full-file regeneration via the shared atomic write util (temp file +
 * rename) -- never a partial update, so callers should pass the complete
 * report they want persisted, not a delta. Stamps/overwrites `updatedAt`
 * with the current time; every other field is the caller's responsibility.
 *
 * Throws on failure rather than swallowing it: callers that can't afford a
 * status-write failure to break their own operation (a git sync cycle, a
 * task-queue poll) wrap this call in best-effort handling at the call site
 * -- see cms-worker.ts's `syncGit`/`processTaskQueue`/`start()`. Any call
 * site that doesn't wrap it falls back on scheduleLoop's existing per-cycle
 * catch, which logs and continues.
 */
export async function writeWorkerStatus(
  taskDir: string,
  report: WorkerStatusReport,
): Promise<void> {
  const filePath = path.join(taskDir, WORKER_STATUS_FILE)
  const stamped: WorkerStatusReport = { ...report, updatedAt: new Date().toISOString() }
  await atomicWriteFile(filePath, JSON.stringify(stamped, null, 2))
}
