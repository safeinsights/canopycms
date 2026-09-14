/**
 * [SYNC-C1] Cross-host mutual exclusion between the worker's rebase loop and content writes
 * against the same branch working tree. docs/concurrency.md has the layering.
 *
 * Production runs a Lambda (API) and an EC2 worker over one EFS filesystem, so `ContentStore`'s
 * in-process mutex (`utils/async-mutex`) does not cover the worker's rebase (`rebaseOneBranch` in
 * worker/rebase.ts) rewriting the same tree. A write landing after `git rebase` started is
 * destroyed either way -- `git checkout --theirs` overwrites it and the rebase then SUCCEEDS
 * silently, or `git rebase --abort` hard-resets the tree -- and the editor already got its 200.
 *
 * **Asymmetric by design.** The worker retries every branch on its next sync cycle (~5 minutes)
 * while the editor is a person waiting on a save, so the worker yields and the writer waits:
 *
 * - Worker: {@link tryAcquireContentWriteLock} -- zero retries, skips the branch this cycle.
 * - Writers: {@link withContentWriteLock} -- a short bounded wait, then
 *   {@link ContentWriteLockBusyError}, which `ContentStore` maps to `BranchSyncingError` and the
 *   API to a 409.
 *
 * **Reads never take this lock.** An extra EFS round-trip on every read is not an acceptable
 * price, and a read racing a rebase gets an older or newer file, never a destroyed one.
 *
 * The marker lives under `{branchRoot}/.canopy-meta` and the lock anchors on that marker path like
 * every other lock (see provisioning-lock.ts), so it can never alias the branch's provisioning
 * lock; the two are never both required and the only possible order (provision, then write) is
 * consistent, so they cannot deadlock. `.canopy-meta/` is git-excluded in every branch clone
 * (`ensureGitExclude`), so the lock directory cannot dirty the tree or be swept into `git add .`.
 *
 * Mutual exclusion is not proven: on EFS a stale cached mtime lets a waiter take over a live lock,
 * leaving two unsynchronized writers -- the unlocked behaviour, so still a strict improvement.
 */

import path from 'node:path'

import { getErrorMessage, isNodeError } from './error'
import { canopyLogWarn } from './logger'
import { tryAcquireProvisioningLock, type OnLockCompromised } from './provisioning-lock'

/** Directory the lock marker lives in, relative to the branch root. */
const META_DIR = '.canopy-meta'

/** On-disk name of the lock marker (a directory, created by mkdir). */
const CONTENT_WRITE_LOCK_NAME = 'content-write.lock'

/**
 * Default bounded wait for a content write.
 *
 * Deliberately short. A rebase holds this lock for a fetch, a replay and N conflict rounds of git
 * subprocesses on EFS -- longer than an interactive save can absorb -- so the wait is not sized to
 * outlast one. It absorbs lock handoff and other writers' short holds, and turns everything longer
 * into a fast, explicit "retry" rather than a request hanging toward the Lambda timeout; the
 * worker revisits the branch next cycle, so the blocked state is transient.
 *
 * It is ALSO the writer-vs-writer budget: the lock is per-branch-root, so every write to one
 * branch serializes behind it -- bounded on Lambda (one invocation per container), but real under
 * `next dev` and build-time provisioning across worker processes. The case to watch is a write
 * whose in-lock path triggers a full `idIndex()` rescan of a large tree over EFS, which can exceed
 * this budget and start 409ing unrelated saves. Making it configurable is tracked in
 * .claude/future-tasks/content-write-lock-tuning-and-granularity.md.
 */
export const DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS = 2000

/**
 * Thrown when the bounded wait expires with the branch's content lock still held. Retriable --
 * callers translate it into a 409 with a message that says so.
 *
 * The message says "syncing OR another save" because BOTH produce it: the lock is taken by
 * `write`/`delete`/`renameEntry` and the admin repair-content-duplicates action as well as by the
 * worker's rebase, so naming only the rebase would claim more than is known. `api/content.ts`
 * routes this error ahead of the generic conflict so the editor sees this wording, making it
 * load-bearing rather than cosmetic.
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
 * Acquire the branch's content-write lock WITHOUT waiting, for the worker's rebase loop, which
 * skips the branch and retries next cycle. Throws with `code === 'ELOCKED'` on a live holder.
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
 * Retries ONLY on genuine contention (`ELOCKED`), the same discipline `withOccFileLock` uses:
 * proper-lockfile's own retry loop retries blindly on any error, burning the whole budget
 * re-hitting e.g. ENOENT after the branch directory was deleted under the caller.
 *
 * @throws ContentWriteLockBusyError when the budget expires under contention.
 */
async function acquireContentWriteLock(
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
      // Exponential backoff with jitter, capped so a long budget still polls often enough to
      // pick the lock up promptly when the holder releases.
      const base = Math.min(40 * 2 ** attempt, 250)
      await sleep(Math.min(base * (0.5 + Math.random()), remaining))
    }
  }
}

/** Run `fn` holding the branch's content-write lock, releasing in a `finally` so a throw cannot
 * strand it. */
export async function withContentWriteLock<T>(
  branchRoot: string,
  fn: () => Promise<T>,
  waitMs: number = DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS,
): Promise<T> {
  // A compromise means this write may not have been exclusive -- the worker's rebase, or another
  // writer, could have been running against the same tree. Reporting success would silently
  // accept a possibly-raced write, so surface the same retriable "branch busy" error (409) that
  // contention maps to and let the caller re-save against the settled tree.
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
    // Deliberately NOT the default "was not saved" message: `fn()` completed, so the write is on
    // disk and only the proof of exclusivity is lost. "Reload, then decide" rather than "retry",
    // which would resend a now-stale expectedVersion and bounce off the caller's own landed write
    // as a phantom editor collision.
    throw new ContentWriteLockBusyError(
      'This branch was being synced while your change was written, so the change may or may not have been recorded. Reload the entry to see the current state before saving again.',
    )
  }
  return result
}
