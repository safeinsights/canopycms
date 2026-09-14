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
 * `stop()` drains for up to `taskTimeoutMs` while a new holder is already
 * running against the same workspace.
 *
 * Readers are stale-tolerant by design: this is a liveness signal, not
 * authoritative state, and NFS/EFS attribute-cache staleness (see
 * docs/concurrency.md) means a reader can see a snapshot a cache window old
 * however carefully it was written.
 */

import path from 'node:path'

import { atomicWriteFile } from '../utils/atomic-write'
import type { WorkerStatusReport } from '../types'

export const WORKER_STATUS_FILE = 'worker-status.json'

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
