import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import lockfile from 'proper-lockfile'

import { getErrorMessage, isFileExistsError, isNodeError } from './error'
import { createDebugLogger } from './debug'

const log = createDebugLogger({ prefix: 'OccJsonWrite' })

/**
 * Shared optimistic-concurrency-control (OCC) JSON write machinery, extracted
 * from the near-identical logic in comment-store.ts and branch-metadata.ts.
 * Both stores keep a `version` + `writeId` pair inside their JSON payload and
 * use temp-file + rename (or temp-file + link for brand-new files) so a
 * concurrent writer is detected rather than silently overwritten.
 */
export class OccWriteConflictError extends Error {
  constructor(message = 'Concurrent modification detected') {
    super(message)
    this.name = 'OccWriteConflictError'
  }
}

export interface OccWriteResult {
  version: number
  writeId: string
}

export interface WriteOccJsonFileOptions {
  /** Version the caller last observed, or null when creating a brand-new file. */
  expectedVersion: number | null
  /**
   * How long to wait after the rename before reading the file back to verify
   * this write's writeId is still present. Default 50ms; pass 0 in tests.
   */
  settleMs?: number
  /** Append a trailing newline after the serialized JSON. Default false. */
  trailingNewline?: boolean
}

/**
 * Write a JSON file using optimistic concurrency control.
 *
 * - New file (`expectedVersion: null`): writes a temp file in the same
 *   directory, then `fs.link()`s it onto the target. link() is atomic and
 *   fails with EEXIST if the target already exists, giving exclusive-create
 *   semantics without the atomicity risk of `writeFile({flag: 'wx'})` — a
 *   crash mid-write with 'wx' can leave a partial file that then fails
 *   JSON.parse on every subsequent read, permanently breaking the resource.
 *   The temp file is unlinked afterward either way (link creates a second
 *   name for the same inode; it does not consume the source).
 * - Existing file: writes a temp file, rechecks the target's current version
 *   against `expectedVersion` (fast-fail before paying for a rename), then
 *   atomically renames the temp file onto the target, waits `settleMs` for
 *   concurrent renames on shared filesystems to land, and reads the file back
 *   to confirm this write's `writeId` won. Any losing writeId means another
 *   process's write landed after ours (or concurrently), so this call throws
 *   {@link OccWriteConflictError}.
 *
 * Temp files are always in the SAME directory as the target: rename and link
 * both require the source and destination to be on the same filesystem, and
 * writing into the same directory also invalidates any local NFS dentry
 * cache for that directory, which the subsequent read-back relies on.
 *
 * ## Guarantee — read this before relying on it for cross-host correctness
 *
 * The post-rename writeId verification detects lost writes reliably only
 * between writers sharing the SAME NFS client (i.e. the same host process, or
 * another process on the same host / local filesystem). Across hosts on EFS,
 * a foreign process's rename can remain invisible to this client's directory
 * dentry/attribute cache for the attribute-cache window (commonly ~3-60s on
 * default EFS mounts) — so a losing writer's read-back can still observe ITS
 * OWN writeId (served from cache) and wrongly conclude it won. The version
 * precheck has the same blind spot: it also reads through that cache, so two
 * concurrent cross-host writers can both see the same `expectedVersion` and
 * both pass. The `settleMs` wait is cheap same-host jitter absorption only —
 * it mitigates nothing for the cross-host case, and is kept solely because it
 * is harmless and occasionally helps same-host callers avoid a spurious retry.
 *
 * For files where a cross-host lost update is unacceptable, callers must ALSO
 * serialize writers with {@link withOccFileLock}, which is enforced by the NFS
 * server itself (mkdir-based locking) rather than by client-side caching.
 */
export async function writeOccJsonFile(
  filePath: string,
  payload: Record<string, unknown>,
  options: WriteOccJsonFileOptions,
): Promise<OccWriteResult> {
  const { expectedVersion, settleMs = 50, trailingNewline = false } = options

  const newVersion = expectedVersion === null ? 1 : expectedVersion + 1
  const writeId = randomUUID()
  const data = { ...payload, version: newVersion, writeId }
  const content = JSON.stringify(data, null, 2) + (trailingNewline ? '\n' : '')

  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tempPath, content, 'utf-8')

  if (expectedVersion === null) {
    try {
      await fs.link(tempPath, filePath)
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {})
      if (isFileExistsError(err)) {
        throw new OccWriteConflictError()
      }
      throw err
    }
    await fs.unlink(tempPath).catch(() => {})
    return { version: newVersion, writeId }
  }

  try {
    // Fast-fail before the rename: not a correctness guarantee (see the
    // cross-host caveat above) but avoids an unnecessary rename + settle +
    // read-back cycle for the common same-host conflict case.
    let currentVersion: number | null = null
    try {
      const current = JSON.parse(await fs.readFile(filePath, 'utf-8')) as { version?: number }
      currentVersion = current.version ?? 0
    } catch {
      currentVersion = null
    }

    if (currentVersion !== expectedVersion) {
      throw new OccWriteConflictError()
    }

    await fs.rename(tempPath, filePath)

    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs))
    }

    const afterWrite = JSON.parse(await fs.readFile(filePath, 'utf-8')) as { writeId?: string }
    if (afterWrite.writeId !== writeId) {
      throw new OccWriteConflictError()
    }
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }

  return { version: newVersion, writeId }
}

export interface WithOccRetryOptions {
  /** Maximum number of attempts, including the first. Default 10. */
  maxAttempts?: number
  /** Additional predicate for errors worth retrying, beyond OccWriteConflictError. */
  isRetryable?: (err: unknown) => boolean
}

/**
 * Retry an OCC write operation on conflict, with exponential backoff + jitter.
 * Non-blocking — the caller's `operation` is expected to reload state (so it
 * observes the latest version) and reapply its change on each attempt.
 */
export async function withOccRetry<T>(
  operation: () => Promise<T>,
  options?: WithOccRetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 10
  const isRetryable = options?.isRetryable

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (err) {
      const retryable = err instanceof OccWriteConflictError || (isRetryable?.(err) ?? false)
      if (retryable && attempt < maxAttempts) {
        const baseDelay = Math.min(10 * Math.pow(2, attempt - 1), 100)
        const jitter = Math.random() * baseDelay
        await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter))
        continue
      }
      throw err
    }
  }
  throw new Error('Unreachable')
}

/**
 * Serialize access to `filePath` across processes using a server-enforced
 * filesystem lock (proper-lockfile), for callers that need a genuine
 * cross-host mutual-exclusion guarantee rather than the best-effort detection
 * that {@link writeOccJsonFile} alone provides.
 *
 * proper-lockfile's locks are mkdir-based: creating a directory is an atomic
 * operation the NFS server itself enforces, so this is immune to the client
 * dentry/attribute caching that undermines writeId verification across hosts.
 * It also auto-refreshes the lock while the holding process is alive, so
 * `stale` only matters when a holder dies without releasing (crash, kill -9).
 *
 * Tuned for brief interactive metadata writes (small JSON files, sub-second
 * critical sections) — shorter and less patient than provisioning-lock.ts's
 * settings, which are sized for build-time git clone/push operations that can
 * legitimately take many seconds.
 */
export async function withOccFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  // Acquisition retries are OUR loop, not proper-lockfile's built-in
  // `retries`: the built-in loop retries blindly on ANY error, so a waiter
  // whose target directory was deleted mid-poll (deleteBranch's rm removing
  // `.canopy-meta/` while a save is queued on its lock) would burn the whole
  // multi-second budget re-hitting ENOENT before failing. Our loop retries
  // only genuine contention (ELOCKED) and fails fast on ENOENT (the resource
  // is gone — retrying cannot succeed and must not resurrect the directory).
  //
  // The retry budget must exceed `stale` (10s): a holder that died without
  // releasing (kill -9) is only taken over once its lock goes stale, so
  // waiters that give up sooner turn every crashed holder into ~10s of hard
  // failures. Base delays 50ms * 1.6^n capped at 2s over 13 retries sum to
  // ~13.5s, comfortably past one stale takeover; jitter only adds to that.
  const MAX_ATTEMPTS = 14
  let release: (() => Promise<void>) | null = null
  for (let attempt = 1; release === null; attempt++) {
    try {
      // Lock the FILE, not the directory: proper-lockfile keys its
      // module-level `locks{}` bookkeeping (release fn, refresh timer) by
      // the resource path passed here. Two concurrent withOccFileLock calls
      // for DIFFERENT files in the SAME directory (comments.json and
      // branch.json both under one `.canopy-meta/`) would otherwise collide
      // on that shared directory key: releasing one lock stops the other's
      // refresh timer, marks it released internally, and leaks its on-disk
      // `.lock` directory. `realpath: false` because the resource path need
      // not exist on disk (brand-new files).
      release = await lockfile.lock(filePath, {
        lockfilePath: `${filePath}.lock`,
        realpath: false,
        stale: 10_000,
        retries: 0,
        // A compromised lock (the lock dir vanished or refresh failed
        // mid-hold, e.g. the branch directory containing it was deleted)
        // must not crash the process, which is proper-lockfile's default.
        // Our critical sections are short and idempotent-on-conflict (OCC
        // verify inside); log and let the section finish.
        onCompromised: (err) => {
          log.warn('lock', `Lock compromised mid-hold for ${filePath}`, {
            error: getErrorMessage(err),
          })
        },
      })
    } catch (err) {
      const code = isNodeError(err) ? err.code : undefined
      const contended = code === 'ELOCKED'
      if (!contended || attempt >= MAX_ATTEMPTS) {
        // Non-contention failure (e.g. ENOENT: the directory was deleted
        // under us) or budget exhausted: surface as the standard conflict
        // type so adopters' boundary translation turns it into their public
        // retriable conflict error instead of a raw ELOCKED/ENOENT leaking
        // out as an opaque 500.
        throw new OccWriteConflictError(`Could not acquire file lock: ${getErrorMessage(err)}`)
      }
      const baseDelay = Math.min(50 * Math.pow(1.6, attempt - 1), 2000)
      const jitter = Math.random() * baseDelay
      await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter))
    }
  }

  try {
    return await fn()
  } finally {
    // Best-effort: a failed release is recovered by `stale` once this
    // process's lockfile heartbeat stops (crash) or the lock naturally
    // expires, so this is logged rather than rethrown.
    //
    // [NIT-1] ENOENT specifically is expected, not an error: the lock
    // marker's target directory legitimately vanishes when an admin purge
    // (see api/admin-branch-health.ts) renames the branch tree out from
    // under a held lock. Every other release failure still warns.
    await release().catch((err: unknown) => {
      if (isNodeError(err) && err.code === 'ENOENT') return
      log.warn('lock', `Failed to release lock for ${filePath}`, { error: getErrorMessage(err) })
    })
  }
}
