import fs from 'node:fs/promises'
import path from 'node:path'

import lockfile from 'proper-lockfile'
import type { LockOptions } from 'proper-lockfile'

import { getErrorMessage, isNodeError } from './error'
import { canopyLogWarn } from './logger'

/**
 * Called when proper-lockfile reports the lock was lost mid-hold (its directory vanished, or a
 * refresh failed and another holder may have taken over).
 *
 * A parameter rather than a fixed policy because every call site must decide what that means for
 * ITS critical section: a compromise during idempotent provisioning is survivable, one during
 * the worker's rebase means a second writer may be live and the next destructive git step must
 * not run. What is NOT negotiable is that it must not throw -- proper-lockfile invokes it from
 * inside the refresh timer, so a throw is an uncaught exception that kills the process.
 */
export type OnLockCompromised = (err: Error) => void

/**
 * Shared option set for both provisioning-lock variants.
 *
 * **The lock is anchored on the lock file's own path, not its directory.** proper-lockfile keys
 * its module-level `locks{}` bookkeeping (refresh timer, release fn) by the TARGET path passed
 * to `lock()`, not by `lockfilePath`, so passing a shared parent makes every branch under one
 * root alias a single registry entry: releasing one tears down the other's refresh timer, fails
 * its release with `ERELEASED`, leaks its lock directory until `stale` expires, and leaves an
 * orphaned timer to `stat` a deleted path and raise `ECOMPROMISED`. Anchoring on the marker
 * makes the registry key identical to the on-disk lock identity, so two live locks can never
 * share one. `realpath: false` because that anchor path does not exist before we create it
 * (realpath would ENOENT). See docs/concurrency.md ("Anchor path matters").
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
    // proper-lockfile invokes this from inside its refresh timer, so ANY throw escaping here is
    // an uncaught exception that kills the process. Call sites are told not to throw (see
    // OnLockCompromised); this makes it structural rather than a convention, and also covers the
    // LOGGER throwing -- under `CI=true`, vitest's `onConsoleLog` turns a console write into a
    // throw.
    onCompromised: (err) => {
      try {
        if (onCompromised) {
          onCompromised(err)
          return
        }
        // Default: log and let the holder finish. proper-lockfile's own default rethrows from
        // the refresh timer, which protects nothing -- by the time a compromise is reported the
        // mutual exclusion is already gone. `canopyLogWarn`, not the debug logger, because "two
        // holders may now be live" must be visible without CANOPYCMS_DEBUG.
        canopyLogWarn(
          `[canopy] Provisioning lock compromised mid-hold for ${lockPath}:`,
          getErrorMessage(err),
        )
      } catch {
        // Last resort: a raw stderr write goes around both a replaced logger and vitest's console
        // interception, so the compromise still leaves a trace. Guarded in turn, because nothing
        // here is allowed to throw out of a refresh timer.
        try {
          process.stderr.write(
            `[canopy] lock compromised for ${lockPath}; its handler or logger threw\n`,
          )
        } catch {
          // Nothing further is safe to attempt.
        }
      }
    },
  }
}

/**
 * proper-lockfile's release rejects with `ERELEASED` once the lock has been marked compromised
 * (`setLockAsCompromised` sets `released = true` before the caller gets to release). Callers hold
 * this in a `finally`, so letting it escape converts a COMPLETED operation into a spurious
 * failure. Nothing is left to release in that state, so swallow just that code and let every
 * other release error propagate.
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
        // Deliberately does not name a cause: ERELEASED is raised both by a lock compromised
        // mid-hold and by a plain double-release bug, indistinguishable from here.
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
 * Acquire a cross-process filesystem lock for content provisioning. Returns a release function —
 * always call it in a `finally`.
 *
 * In-memory locks serialize only within one process, but build tools such as Next.js static
 * generation provision content from parallel worker *processes*, which then race while creating
 * the same git workspace ("cannot mkdir remote.git: File exists", "destination path already
 * exists"). proper-lockfile's atomic on-disk lock holds across processes, so one provisions while
 * the others wait and then find it already done.
 *
 * @param onCompromised see {@link OnLockCompromised}; defaults to log-and-continue
 */
export async function acquireProvisioningLock(
  lockTargetDir: string,
  lockName: string,
  onCompromised?: OnLockCompromised,
): Promise<() => Promise<void>> {
  await fs.mkdir(lockTargetDir, { recursive: true })
  const lockPath = path.join(lockTargetDir, lockName)

  // Generous, jittered retries: several processes may contend for one workspace (Lambda
  // containers cold-starting together against one EFS root), and the holder can take seconds to
  // init plus clone/push. `randomize` de-syncs the herd so a waiter is not perpetually colliding
  // on the same tick. `stale` stays modest because proper-lockfile auto-refreshes a live holder's
  // lock, so it expires only when a process actually dies.
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
 * Zero-retry variant of {@link acquireProvisioningLock}, for admin actions inside a synchronous
 * request/response cycle (a Lambda-backed API handler). `acquireProvisioningLock`'s ~600-retry
 * budget waits minutes for a live provisioner; an admin request must fail fast instead.
 *
 * `stale: 30_000` is unchanged from the patient variant: a genuinely stale lock (holder crashed
 * more than 30s ago) is still taken over normally. Only the RETRY loop for live contention is
 * removed, not the staleness recovery a caller depends on -- see branch-health.ts's [H1]
 * freshness rail, which reads this lock's mtime before an admin purge/repair proceeds.
 *
 * Throws with `err.code === 'ELOCKED'` on contention (a live, non-stale holder) -- callers
 * translate that into a 409.
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
