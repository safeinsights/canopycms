import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import lockfile from 'proper-lockfile'

import { getErrorMessage, isFileExistsError } from './error'
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

  const release = await lockfile.lock(dir, {
    lockfilePath: `${filePath}.lock`,
    realpath: false,
    stale: 10_000,
    retries: { retries: 20, factor: 1.5, minTimeout: 25, maxTimeout: 250, randomize: true },
  })

  try {
    return await fn()
  } finally {
    // Best-effort: a failed release is recovered by `stale` once this
    // process's lockfile heartbeat stops (crash) or the lock naturally
    // expires, so this is logged rather than rethrown.
    await release().catch((err: unknown) => {
      log.warn('lock', `Failed to release lock for ${filePath}`, { error: getErrorMessage(err) })
    })
  }
}
