import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './utils/atomic-write'
import { getErrorMessage, isNodeError } from './utils/error'
import { createDebugLogger } from './utils/debug'

/**
 * Generalized cross-process generation marker for any on-disk resource that
 * is durably cached under a branch-clone (or similar) root.
 *
 * Some in-process cache is kept per resource per process (an in-memory index,
 * a parsed schema, a registry snapshot). Within one process, mutating code can
 * invalidate that cache directly. Across processes (several warm Lambda
 * containers + the EC2 worker sharing branch clones on EFS) there is no
 * shared memory and no cross-host file watching, so the shared filesystem
 * itself is the coordination medium: every operation that mutates the
 * resource also rewrites a small marker file with a fresh random token, and
 * every consumer cheaply re-reads that marker (throttled) to decide whether
 * its cached snapshot is still current.
 *
 * The marker for a given `resource` lives at {root}/.canopy-meta/{resource}.generation:
 * `.canopy-meta/` is the established per-clone internal dir — dot-prefixed (so
 * content and index scans skip it) and excluded from git via .git/info/exclude.
 *
 * ## Why a random token instead of a monotonic counter
 *
 * Readers only need "did it change since I captured it", so inequality against
 * the captured value suffices. A counter would need read-modify-write, which
 * silently loses concurrent bumps without a lock (two bumpers read 5, both
 * write 6 — a reader that recorded 6 after the first bump never learns of the
 * second mutation). A unique token per bump has no lost-update problem, needs
 * no lock, and avoids NFS mtime-granularity / cross-host clock-skew issues.
 * Each bump is a single atomic temp-file + rename.
 *
 * ## Ordering protocol (correctness)
 *
 * - Bumpers write the marker strictly AFTER their filesystem mutations.
 * - Readers capture the marker token strictly BEFORE scanning/rebuilding the
 *   resource, and record it only after the rebuild completes. A bump landing
 *   mid-rebuild therefore leaves the recorded token older than the file,
 *   forcing another rebuild on the next probe.
 *
 * ## Consistency guarantees and residual staleness windows (EFS/NFSv4)
 *
 * Guaranteed: any completed mutation that bumps the marker is observed by
 * every consumer on that root at its next freshness probe. Residual windows
 * (bounded in practice by per-request lifetimes and, where implemented, a
 * suspicious-lookup backstop):
 *
 * - (A) NFS attribute caching (benign direction): another host may not see a
 *   new marker for up to the attribute-cache timeout (~3-60s on default EFS
 *   mounts; `noac` cannot be assumed). The reader acts on a stale token and
 *   keeps a stale snapshot until the cache expires.
 * - (B) Probe throttle: however long the consumer debounces freshness checks.
 * - (C) Self-adoption: after its own mutation a consumer adopts the token it
 *   wrote; if a concurrent foreign bump landed just before ours, we miss that
 *   one notification (window: from our last token observation to our rename).
 * - (E) Fresh-token/stale-scan (malignant direction, cross-host only): NFS
 *   revalidates the marker file on open, but a rebuild's reads may be served
 *   from dentry/attribute caches — a rebuild can record a NEW token against
 *   PRE-mutation data, leaving that consumer confidently stale until the next
 *   bump. Structurally unfixable with a filesystem marker; bounded by
 *   per-request lifetimes and any backstop the consumer implements.
 *
 * ## Guarantee delta for DURABLE snapshot consumers (registry / schema-cache)
 *
 * The in-memory ContentIdIndex tolerates window (E) because a stale index is
 * scoped to one process's memory: it self-heals on the next probe or process
 * recycle, and a wrong-file write is independently guarded by ContentStore's
 * existence check. Consumers that persist a durable snapshot ALONGSIDE this
 * marker — a branch registry list, a resolved-schema cache file — do not get
 * that same containment. If such a consumer's regeneration scan is served
 * from stale NFS dentry/attribute caches, window (E) produces a snapshot that
 * embeds a FRESH token over STALE data, and that snapshot is written to disk.
 * Every other host that reads the marker sees the fresh token, concludes the
 * durable snapshot is current, and serves the stale data too — this is now a
 * durable, SHARED staleness visible to all hosts until the next bump, not a
 * transient one-process condition. A random token cannot distinguish "fresh
 * token over fresh data" from "fresh token over stale data" — the token only
 * proves a bump happened, not that the bumping host's own scan observed it.
 *
 * Durable-snapshot consumers must therefore implement mitigations this module
 * cannot provide on their behalf:
 *
 * - Eager regeneration on the mutating host, performed immediately after its
 *   own bump (in the same request/operation). That host's own scan is
 *   necessarily coherent with the mutation it just made (no NFS round trip
 *   was needed to observe its own writes), so regenerating there rather than
 *   waiting for a lazy pull on some other host avoids handing window (E) a
 *   chance to run at all for the common case.
 * - A get-miss / suspicious-lookup backstop: if a consumer looks up something
 *   that "should" exist per the durable snapshot but is missing (or vice
 *   versa), that mismatch is a signal to force a fresh regeneration rather
 *   than trusting the token match, bounding how long a bad snapshot survives.
 */

const log = createDebugLogger({ prefix: 'ResourceGeneration' })

const META_DIR = '.canopy-meta'

/** Absolute path of the generation marker for `resource` under `root`. */
export function resourceGenerationPath(root: string, resource: string): string {
  return path.resolve(root, META_DIR, `${resource}.generation`)
}

export interface BumpResourceGenerationOptions {
  /**
   * When true, a failed bump rethrows instead of being logged and swallowed.
   * Use this for callers where a lost bump means indefinitely stale durable
   * data with no bounding backstop (e.g. a registry's invalidate()) — those
   * callers must not silently succeed while leaving stale readers unaware.
   * Default false (hint flavor): log-warn and swallow, since the mutation
   * itself is already durable and a lost bump only degrades to pre-marker
   * staleness behavior plus whatever backstop the consumer has.
   */
  mustSucceed?: boolean
}

/**
 * Record on disk that `resource` changed under `root`, so consumers in OTHER
 * processes rebuild. Must be called AFTER the filesystem mutation.
 *
 * Returns the token written, or null if the write failed and `mustSucceed`
 * was not set (logged and swallowed).
 */
export async function bumpResourceGeneration(
  root: string,
  resource: string,
  options?: BumpResourceGenerationOptions,
): Promise<string | null> {
  const token = randomUUID()
  try {
    await atomicWriteFile(resourceGenerationPath(root, resource), token)
    return token
  } catch (err) {
    log.warn('generation', `Failed to bump ${resource} generation for ${root}`, {
      error: getErrorMessage(err),
    })
    if (options?.mustSucceed) throw err
    return null
  }
}

/**
 * Result of reading a generation marker. `ok: false` means the read failed
 * for a reason OTHER than "marker doesn't exist yet" — callers should treat
 * this as "force regenerate" rather than folding it into a token value,
 * because a legitimate snapshot can embed `token: null` (a fresh clone,
 * regenerated before any bump ever occurred) and that must stay
 * distinguishable from "we don't actually know the current token".
 */
export type GenerationReadResult = { ok: true; token: string | null } | { ok: false }

/**
 * Read the current generation token for `resource` under `root`.
 *
 * ENOENT maps to `{ok: true, token: null}` — a valid "never bumped" state,
 * distinct from every real token. Any OTHER read error maps to `{ok: false}`
 * (logged) so callers can force-regenerate instead of trusting a null they
 * cannot actually attribute to "never bumped".
 */
export async function readResourceGeneration(
  root: string,
  resource: string,
): Promise<GenerationReadResult> {
  try {
    const token = await fs.readFile(resourceGenerationPath(root, resource), 'utf-8')
    return { ok: true, token }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return { ok: true, token: null }
    log.warn('generation', `Failed to read ${resource} generation for ${root}`, {
      error: getErrorMessage(err),
    })
    return { ok: false }
  }
}

/**
 * True when a previously-captured snapshot token is still current: the read
 * succeeded AND its token matches the snapshot's. A failed read (`ok: false`)
 * is never current, even if the snapshot's token happens to be null — an
 * unreadable marker means we cannot vouch for freshness either way, and the
 * safe default is to treat it as stale.
 */
export function isGenerationCurrent(
  snapshotToken: string | null,
  read: GenerationReadResult,
): boolean {
  return read.ok && read.token === snapshotToken
}
