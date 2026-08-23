/**
 * [SYNC-C1] Cross-host mutual exclusion between the worker's rebase loop and
 * content writes against the same branch working tree.
 *
 * Production runs a Lambda (API) and an EC2 worker over one EFS filesystem.
 * `ContentStore`'s write/delete/rename critical sections were guarded only by
 * the in-process mutex (`utils/async-mutex`), which does not cross that
 * boundary, while the worker's rebase loop (`rebaseOneBranch` in
 * worker/rebase.ts) rewrites the very same
 * working tree. A write landing after `git rebase` started is destroyed two
 * ways -- `git checkout --theirs <file>` overwrites it with the branch's
 * committed version (and the rebase then SUCCEEDS, logging nothing), and
 * `git rebase --abort` hard-resets the tree. Either way the editor already got
 * its 200. This lock is what serializes the two.
 *
 * **Asymmetric by design.** The worker retries every branch on its next sync
 * cycle (~5 minutes) while the editor is a person waiting on a save, so the
 * worker yields and the writer waits:
 *
 * - Worker: {@link tryAcquireContentWriteLock} -- zero retries. On contention
 *   it skips that branch this cycle (an extension of the existing
 *   skip-dirty-branches behavior) and picks it up next cycle.
 * - Writers: {@link withContentWriteLock} -- a short bounded wait, then a
 *   retriable failure the API surfaces as a 409.
 *
 * **Reads never take this lock.** An extra EFS round-trip on every read is not
 * an acceptable price, and a read racing a rebase gets a consistent-enough
 * older or newer file, never a destroyed one.
 *
 * ## Why the lock marker lives under `{branchRoot}/.canopy-meta`
 *
 * proper-lockfile keys its module-level `locks{}` bookkeeping (refresh timer,
 * release function) by the **target path** passed to `lock()`, NOT by
 * `lockfilePath`. `provisioning-lock.ts` now anchors every lock on its own
 * marker path, so the registry key equals the on-disk lock identity and two
 * live locks can no longer share a key -- aliasing is structurally impossible
 * rather than merely avoided by convention. Keeping the content lock under
 * `{branchRoot}/.canopy-meta` still buys:
 *
 * - a per-branch marker, so one branch's content lock is independent of every
 *   other branch's and of that branch's provisioning lock; and
 * - no deadlock potential: the two locks are never both required, and the only
 *   possible acquisition order (provision, then write) is consistent.
 *
 * `.canopy-meta/` is git-excluded in every branch clone (`ensureGitExclude`),
 * so the lock directory can never dirty the working tree or be swept into
 * `git add .` at publish time.
 *
 * ## Honest caveat (do not oversell this)
 *
 * `proper-lockfile` decides a holder is dead by reading the lock directory's
 * mtime with `fs.stat`, which on EFS is served through the NFS attribute
 * cache. A live holder refreshes every `stale/2`, but a waiter can read a
 * cached mtime and conclude the lock is stale when it is not, taking it over.
 * The failure mode of a bad takeover is exactly today's behavior (two
 * unsynchronized writers), so this is a strict improvement -- not a proof of
 * mutual exclusion. See docs/concurrency.md.
 */

import path from 'node:path'

import { getErrorMessage, isNodeError } from './error'
import { canopyLogWarn } from './logger'
import { tryAcquireProvisioningLock, type OnLockCompromised } from './provisioning-lock'

/** Directory the lock marker lives in, relative to the branch root. */
const META_DIR = '.canopy-meta'

/** On-disk name of the lock marker (a directory, created by mkdir). */
export const CONTENT_WRITE_LOCK_NAME = 'content-write.lock'

/**
 * Default bounded wait for a content write.
 *
 * Deliberately short. A rebase holds this lock for a fetch plus a replay plus
 * N conflict rounds of git subprocesses on EFS -- far longer than any wait an
 * interactive save can absorb, and longer than the API's own latency budget.
 * So the wait is not sized to outlast a rebase (nothing reasonable could); it
 * is sized to absorb lock handoff and the short holds of other writers, and to
 * turn everything longer into a fast, explicit "retry" the editor can act on
 * rather than a request that hangs toward the Lambda timeout. The worker
 * revisits the branch next cycle, so the blocked state is transient.
 *
 * This is ALSO the writer-vs-writer budget, not only the rebase one. The lock
 * is per-branch-root, so every write to one branch now serializes behind it
 * where in-process serialization used to be per-entry -- bounded on Lambda
 * (one invocation per container), but real under `next dev` and build-time
 * provisioning across worker processes. The case to watch is a write whose
 * in-lock path triggers a full `idIndex()` rescan of a large tree over EFS:
 * that can plausibly exceed this budget and start 409ing unrelated saves.
 * Making it configurable for prod tuning is tracked in
 * .claude/future-tasks/content-write-lock-tuning-and-granularity.md.
 */
export const DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS = 2000

/**
 * Thrown when the bounded wait expires with the branch's content lock still
 * held. Retriable -- callers translate this into a 409 with a message that
 * says so.
 *
 * The message says "syncing OR another save" because BOTH produce it. The
 * lock is taken by `write`/`delete`/`renameEntry` and by the admin
 * repair-content-duplicates action as well as by the worker's rebase, so a
 * message naming only the rebase was a confident claim about something that
 * may not be happening. `api/content.ts` routes this error ahead of the
 * generic conflict specifically so the editor sees this wording, which makes
 * the wording load-bearing rather than cosmetic.
 */
export class ContentWriteLockBusyError extends Error {
  constructor(
    message = 'This branch is busy (syncing with the base branch, or another save is in flight); the change was not saved. Try again in a moment.',
  ) {
    super(message)
    this.name = 'ContentWriteLockBusyError'
  }
}

/** Directory the lock marker is created in. proper-lockfile anchors on the
 * marker path itself (see provisioning-lock.ts), not on this directory. */
function lockTargetDir(branchRoot: string): string {
  return path.join(path.resolve(branchRoot), META_DIR)
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Acquire the branch's content-write lock WITHOUT waiting.
 *
 * Throws an error with `code === 'ELOCKED'` when a live holder has it. Used by
 * the worker's rebase loop (which skips the branch and retries next cycle) and
 * by tests standing in for a writer.
 */
export function tryAcquireContentWriteLock(
  branchRoot: string,
  onCompromised?: OnLockCompromised,
): Promise<() => Promise<void>> {
  return tryAcquireProvisioningLock(
    lockTargetDir(branchRoot),
    CONTENT_WRITE_LOCK_NAME,
    onCompromised,
  )
}

/**
 * Acquire the branch's content-write lock with a short bounded wait.
 *
 * Retries ONLY on genuine contention (`ELOCKED`), the same discipline
 * `withOccFileLock` uses: proper-lockfile's own retry loop retries blindly on
 * any error, which would burn the whole budget re-hitting e.g. ENOENT after
 * the branch directory was deleted out from under the caller.
 *
 * @throws ContentWriteLockBusyError when the budget expires under contention.
 */
export async function acquireContentWriteLock(
  branchRoot: string,
  waitMs: number = DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS,
  onCompromised?: OnLockCompromised,
): Promise<() => Promise<void>> {
  const startedAt = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await tryAcquireContentWriteLock(branchRoot, onCompromised)
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== 'ELOCKED') throw err
      const remaining = waitMs - (Date.now() - startedAt)
      if (remaining <= 0) throw new ContentWriteLockBusyError()
      // Exponential backoff with jitter, capped so a long budget still polls
      // often enough to pick the lock up promptly when the holder releases.
      const base = Math.min(40 * 2 ** attempt, 250)
      await sleep(Math.min(base * (0.5 + Math.random()), remaining))
    }
  }
}

/**
 * Run `fn` holding the branch's content-write lock, releasing it in a
 * `finally` so a throw can never strand it.
 */
export async function withContentWriteLock<T>(
  branchRoot: string,
  fn: () => Promise<T>,
  waitMs: number = DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS,
): Promise<T> {
  // A compromise means this write may no longer have been exclusive -- the
  // worker's rebase (or another writer) could have been running against the
  // same tree. Reporting success would silently accept a possibly-raced write,
  // so surface the same retriable "branch busy" error contention already maps
  // to (409) and let the caller re-save against the settled tree.
  let compromised = false
  const release = await acquireContentWriteLock(branchRoot, waitMs, (err) => {
    compromised = true
    canopyLogWarn(
      `[canopy] Content-write lock compromised mid-hold for ${branchRoot}:`,
      getErrorMessage(err),
    )
  })
  let result: T
  try {
    result = await fn()
  } finally {
    await release()
  }
  if (compromised) {
    // Deliberately NOT the default "was not saved" message: `fn()` completed,
    // so the write is on disk. What we lost is the proof it was exclusive, so
    // the honest instruction is "reload, then decide" rather than "retry",
    // which would resend a now-stale expectedVersion and bounce off the
    // caller's own landed write as a phantom editor collision.
    throw new ContentWriteLockBusyError(
      'This branch was being synced while your change was written, so the change may or may not have been recorded. Reload the entry to see the current state before saving again.',
    )
  }
  return result
}
