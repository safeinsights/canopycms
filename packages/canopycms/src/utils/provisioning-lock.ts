import fs from 'node:fs/promises'
import path from 'node:path'

import lockfile from 'proper-lockfile'
import type { LockOptions } from 'proper-lockfile'

import { getErrorMessage, isNodeError } from './error'
import { canopyLogWarn } from './logger'

/**
 * Called when proper-lockfile reports the lock was lost mid-hold (its directory
 * vanished, or a refresh failed and another holder may have taken over).
 *
 * Every call site must decide what that means for ITS critical section, which
 * is why this is a parameter rather than a fixed policy: a compromise during
 * idempotent provisioning is survivable, but a compromise during the worker's
 * rebase means a second writer may be live and the next destructive git step
 * must not run. What is NOT negotiable is that it must not throw --
 * proper-lockfile invokes it from inside the refresh timer, so a throw is an
 * uncaught exception that kills the process.
 */
export type OnLockCompromised = (err: Error) => void

/**
 * Shared option set for both provisioning-lock variants.
 *
 * **The lock is anchored on the lock file's own path, not its directory.**
 * proper-lockfile keys its module-level `locks{}` bookkeeping (refresh timer,
 * release fn) by the TARGET path passed to `lock()` — not by `lockfilePath`.
 * Passing the shared branches directory made every branch under one root alias
 * a single registry entry: acquiring `.b.init.lock` overwrote `.a.init.lock`'s
 * entry, so releasing A tore down B's refresh timer, made B's own release fail
 * with `ERELEASED`, and leaked B's lock directory on disk until `stale`
 * expired. The orphaned refresh timer then `stat`ed a path its owner had
 * already deleted, raising `ECOMPROMISED`. Anchoring here makes the registry
 * key identical to the on-disk lock identity, so two live locks can never
 * share a key. `realpath: false` because the anchor path is the lock marker
 * itself and does not exist before we create it (realpath would ENOENT).
 * See docs/concurrency.md ("Anchor path matters").
 */
function provisioningLockOptions(
  lockPath: string,
  retries: LockOptions['retries'],
  onCompromised: OnLockCompromised | undefined,
): LockOptions {
  return {
    lockfilePath: lockPath,
    realpath: false,
    retries,
    stale: 30_000,
    // proper-lockfile invokes this from inside its refresh timer, so ANY throw
    // escaping here is an uncaught exception that kills the process -- the very
    // failure the handler exists to prevent. Call sites are told not to throw
    // (see OnLockCompromised); this makes it structural rather than a
    // convention, and also covers the LOGGER throwing: under `CI=true`,
    // vitest's `onConsoleLog` turns any console write into a throw.
    onCompromised: (err) => {
      try {
        if (onCompromised) {
          onCompromised(err)
          return
        }
        // Default: log and let the holder finish. proper-lockfile's own default
        // rethrows from the refresh timer, which protects nothing -- by the time
        // a compromise is reported the mutual exclusion is already gone.
        // `canopyLogWarn` (not the debug logger) because this means "two
        // holders may now be live": it must be visible without CANOPYCMS_DEBUG.
        canopyLogWarn(
          `[canopy] Provisioning lock compromised mid-hold for ${lockPath}:`,
          getErrorMessage(err),
        )
      } catch {
        // Nothing further is safe to attempt -- reporting the reporting
        // failure could throw for exactly the same reason.
      }
    },
  }
}

/**
 * proper-lockfile's release rejects with `ERELEASED` once the lock has been
 * marked compromised (`setLockAsCompromised` sets `released = true` before the
 * caller ever gets to release). Callers hold this in a `finally`, so letting
 * that escape would convert a COMPLETED operation into a spurious failure.
 * There is nothing left to release in that state, so swallow just that code and
 * let every other release error propagate to the caller that asked for it.
 */
function releaseIgnoringAlreadyReleased(
  release: () => Promise<void>,
  lockPath: string,
): () => Promise<void> {
  return async () => {
    try {
      await release()
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ERELEASED') {
        // Deliberately does not name a cause: ERELEASED is raised both by a
        // lock compromised mid-hold AND by a plain double-release bug, and
        // from here the two are indistinguishable.
        canopyLogWarn(
          `[canopy] Lock at ${lockPath} was already released (compromised mid-hold, or released twice); nothing to release`,
        )
        return
      }
      throw err
    }
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
 * @param onCompromised see {@link OnLockCompromised}; defaults to log-and-continue
 */
export async function acquireProvisioningLock(
  lockTargetDir: string,
  lockName: string,
  onCompromised?: OnLockCompromised,
): Promise<() => Promise<void>> {
  await fs.mkdir(lockTargetDir, { recursive: true })
  const lockPath = path.join(lockTargetDir, lockName)

  // Generous, jittered retries: many waiters (one per build worker process, each
  // prerendering several pages) may contend, and the holder can take several
  // seconds to init + clone/push. `randomize` de-syncs the herd so a waiter isn't
  // perpetually colliding on the same tick. `stale` stays modest because proper-
  // lockfile auto-refreshes a live holder's lock, so it only expires when a
  // process actually dies.
  const release = await lockfile.lock(
    lockPath,
    provisioningLockOptions(
      lockPath,
      { retries: 600, factor: 1, minTimeout: 300, maxTimeout: 800, randomize: true },
      onCompromised,
    ),
  )
  return releaseIgnoringAlreadyReleased(release, lockPath)
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
  onCompromised?: OnLockCompromised,
): Promise<() => Promise<void>> {
  await fs.mkdir(lockTargetDir, { recursive: true })
  const lockPath = path.join(lockTargetDir, lockName)

  const release = await lockfile.lock(lockPath, provisioningLockOptions(lockPath, 0, onCompromised))
  return releaseIgnoringAlreadyReleased(release, lockPath)
}
