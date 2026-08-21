import fs from 'node:fs/promises'
import path from 'node:path'

import lockfile from 'proper-lockfile'
import type { LockOptions } from 'proper-lockfile'

import { getErrorMessage } from './error'
import { createDebugLogger } from './debug'

const log = createDebugLogger({ prefix: 'ProvisioningLock' })

/**
 * Shared option set for both provisioning-lock variants.
 *
 * Two details are load-bearing and must stay in sync between them:
 *
 * 1. **The lock is anchored on the lock file's own path, not its directory.**
 *    proper-lockfile keys its module-level `locks{}` bookkeeping (refresh
 *    timer, release fn) by the TARGET path passed to `lock()` — not by
 *    `lockfilePath`. Passing the shared branches directory made every branch
 *    under one root alias a single registry entry: acquiring `.b.init.lock`
 *    overwrote `.a.init.lock`'s entry, so releasing A tore down B's refresh
 *    timer, made B's own release fail with `ERELEASED`, and leaked B's lock
 *    directory on disk until `stale` expired. The orphaned refresh timer then
 *    `stat`ed a path its owner had already deleted, which surfaced as an
 *    `ECOMPROMISED` uncaught exception. `realpath: false` because the anchor
 *    path is the lock marker itself and need not exist before we create it.
 *    See docs/concurrency.md ("Anchor path matters").
 *
 * 2. **A compromised lock must not kill the process.** proper-lockfile's
 *    default `onCompromised` rethrows from the refresh timer, i.e. an uncaught
 *    exception. Crashing protects nothing here: by the time the lock is
 *    reported compromised the mutual exclusion it provided is already gone, so
 *    killing the process (a Lambda serving unrelated requests, or a Vitest
 *    worker) only converts a lock failure into an outage. Log it and let the
 *    in-flight operation finish — `initializeWorkspace` is idempotent, and a
 *    genuine concurrent provisioner fails loudly on its own ("destination path
 *    already exists") rather than corrupting anything silently.
 */
function provisioningLockOptions(lockPath: string, retries: LockOptions['retries']): LockOptions {
  return {
    lockfilePath: lockPath,
    realpath: false,
    retries,
    stale: 30_000,
    onCompromised: (err) => {
      log.warn('lock', `Provisioning lock compromised mid-hold for ${lockPath}`, {
        error: getErrorMessage(err),
      })
    },
  }
}

/**
 * Acquire a cross-process filesystem lock for content provisioning.
 *
 * In-memory locks only serialize work within a single process. Build tools such
 * as Next.js static generation provision content from parallel worker
 * *processes*, so two processes can otherwise race while creating the same git
 * workspace (e.g. "cannot mkdir remote.git: File exists" or "destination path
 * already exists"). proper-lockfile uses an atomic on-disk lock that holds across
 * processes, so only one provisions a given resource at a time while the others
 * wait and then find it already done.
 *
 * Returns a release function — always call it in a `finally`.
 *
 * @param lockTargetDir directory the lock marker lives in (created if missing)
 * @param lockName name of the on-disk lock marker, created inside lockTargetDir
 */
export async function acquireProvisioningLock(
  lockTargetDir: string,
  lockName: string,
): Promise<() => Promise<void>> {
  await fs.mkdir(lockTargetDir, { recursive: true })

  // Generous, jittered retries: many waiters (one per build worker process, each
  // prerendering several pages) may contend, and the holder can take several
  // seconds to init + clone/push. `randomize` de-syncs the herd so a waiter isn't
  // perpetually colliding on the same tick. `stale` stays modest because proper-
  // lockfile auto-refreshes a live holder's lock, so it only expires when a
  // process actually dies.
  const lockPath = path.join(lockTargetDir, lockName)
  return lockfile.lock(
    lockPath,
    provisioningLockOptions(lockPath, {
      retries: 600,
      factor: 1,
      minTimeout: 300,
      maxTimeout: 800,
      randomize: true,
    }),
  )
}

/**
 * Zero-retry variant of {@link acquireProvisioningLock}, for admin actions
 * running inside a synchronous request/response cycle (e.g. a Lambda-backed
 * API handler). `acquireProvisioningLock`'s ~600-retry budget is sized for a
 * build worker that can afford to wait several minutes for a live
 * provisioner to finish; an admin request must fail fast on contention
 * instead (409 immediately) rather than hang the request for that long.
 *
 * `stale: 30_000` is unchanged from the patient variant: a genuinely stale
 * lock (holder crashed more than 30s ago) is still taken over normally --
 * this only removes the RETRY loop for live contention, not the staleness
 * recovery a caller depends on (see branch-health.ts's [H1] freshness rail,
 * which reads this same lock's mtime to decide whether it is fresh or
 * stale before an admin purge/repair proceeds).
 *
 * Throws with `err.code === 'ELOCKED'` on contention (a live, non-stale
 * holder) -- callers should translate that into a 409.
 */
export async function tryAcquireProvisioningLock(
  lockTargetDir: string,
  lockName: string,
): Promise<() => Promise<void>> {
  await fs.mkdir(lockTargetDir, { recursive: true })

  const lockPath = path.join(lockTargetDir, lockName)
  return lockfile.lock(lockPath, provisioningLockOptions(lockPath, 0))
}
