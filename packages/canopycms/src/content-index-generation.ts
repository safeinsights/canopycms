import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './utils/atomic-write'
import { getErrorMessage, isNodeError } from './utils/error'
import { invalidateContentIndexesForRoot } from './content-index-registry'
import { createDebugLogger } from './utils/debug'

/**
 * Cross-process ContentId index generation marker.
 *
 * The ContentIdIndex is an in-memory map per ContentStore instance. Within one
 * process, content-index-registry.ts invalidates stale indexes directly. Across
 * processes (several warm Lambda containers + the EC2 worker sharing branch
 * clones on EFS) there is no shared memory and no cross-host file watching, so
 * the shared filesystem itself is the coordination medium: every operation that
 * mutates indexed files under a branch-clone root also rewrites a small marker
 * file with a fresh random token, and every ContentStore cheaply re-reads that
 * marker (throttled) to decide whether its in-memory index is still current.
 *
 * The marker lives at {root}/.canopy-meta/content-index.generation:
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
 * - Readers capture the marker token strictly BEFORE scanning the tree, and
 *   record it only after the scan completes. A bump landing mid-scan therefore
 *   leaves the recorded token older than the file, forcing a rebuild on the
 *   next probe.
 *
 * ## Consistency guarantees and residual staleness windows (EFS/NFSv4)
 *
 * Guaranteed: any completed mutation that bumps the marker is observed by every
 * store on that root at its next freshness probe. Residual windows, all bounded
 * in practice by per-request ContentStore lifetimes and self-healed by the
 * suspicious-lookup backstop in ContentStore:
 *
 * - (A) NFS attribute caching (benign direction): another host may not see a
 *   new marker for up to the attribute-cache timeout (~3-60s on default EFS
 *   mounts; `noac` cannot be assumed). The reader acts on a stale token and
 *   keeps a stale index until the cache expires.
 * - (B) Probe throttle: up to ContentStore's indexFreshnessIntervalMs (1s).
 * - (C) Self-adoption: after its own mutation a store adopts the token it
 *   wrote; if a concurrent foreign bump landed just before ours, we miss that
 *   one notification (window: from our last token observation to our rename).
 * - (E) Fresh-token/stale-scan (malignant direction, cross-host only): NFS
 *   revalidates the marker file on open, but a rebuild's readdir calls may be
 *   served from dentry/attribute caches — a scan can record a NEW token against
 *   PRE-mutation directory listings, leaving that store confidently stale until
 *   the next bump. Structurally unfixable with a filesystem marker; bounded by
 *   per-request store lifetimes and the backstop.
 *
 * Wrong-file WRITE corruption (recreating a concurrently renamed entry →
 * duplicate IDs) is prevented independently of this marker by the existence
 * guard in ContentStore.write(), which consults the actual directory listing
 * before recreating a missing expected file.
 */

const log = createDebugLogger({ prefix: 'ContentIndex' })

/** Matches BRANCH_META_DIR in branch-metadata.ts — the per-clone internal dir. */
const META_DIR = '.canopy-meta'
const GENERATION_FILE = 'content-index.generation'

/** Absolute path of the generation marker for a branch-clone root. */
export function contentIndexGenerationPath(root: string): string {
  return path.join(path.resolve(root), META_DIR, GENERATION_FILE)
}

/**
 * Record on disk that indexed files under `root` changed, so ContentStores in
 * OTHER processes rebuild. Must be called AFTER the filesystem mutation.
 * Returns the token written, or null if the write failed (logged and swallowed:
 * the content mutation is already durable; a lost bump degrades to the
 * pre-marker staleness behavior plus the ContentStore backstop).
 */
export async function bumpContentIndexGeneration(root: string): Promise<string | null> {
  const token = randomUUID()
  try {
    await atomicWriteFile(contentIndexGenerationPath(root), token)
    return token
  } catch (err) {
    log.warn('generation', `Failed to bump content index generation for ${root}`, {
      error: getErrorMessage(err),
    })
    return null
  }
}

/**
 * Read the current generation token for `root`. Returns null if the marker
 * does not exist yet (a valid state distinct from every token). Read errors
 * other than ENOENT are logged and treated as null — the caller then rebuilds,
 * which is the safe direction.
 */
export async function readContentIndexGeneration(root: string): Promise<string | null> {
  try {
    return await fs.readFile(contentIndexGenerationPath(root), 'utf-8')
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null
    log.warn('generation', `Failed to read content index generation for ${root}`, {
      error: getErrorMessage(err),
    })
    return null
  }
}

/**
 * The single entry point for operations that mutate indexed files under a
 * branch-clone root: git working-tree mutations, content sync, collection
 * directory operations, CLI sync. Bumps the on-disk marker (cross-process),
 * then invalidates in-process registered stores.
 *
 * Bump-before-invalidate: the in-process invalidation triggers a rebuild on
 * next access, and that rebuild captures the marker token before scanning —
 * writing the marker first lets the rebuild pick up the new token in the same
 * pass instead of a redundant second rebuild.
 */
export async function invalidateContentIndexesDurable(root: string): Promise<void> {
  await bumpContentIndexGeneration(root)
  invalidateContentIndexesForRoot(root)
}
