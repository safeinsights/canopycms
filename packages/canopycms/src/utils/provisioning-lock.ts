import fs from 'node:fs/promises'
import path from 'node:path'

import lockfile from 'proper-lockfile'

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
 * @param lockTargetDir directory the lock is anchored on (created if missing)
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
  return lockfile.lock(lockTargetDir, {
    lockfilePath: path.join(lockTargetDir, lockName),
    retries: { retries: 600, factor: 1, minTimeout: 300, maxTimeout: 800, randomize: true },
    stale: 30_000,
  })
}
