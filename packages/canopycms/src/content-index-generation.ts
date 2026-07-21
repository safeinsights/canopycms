import {
  resourceGenerationPath,
  bumpResourceGeneration,
  readResourceGeneration,
} from './resource-generation'
import { invalidateContentIndexesForRoot } from './content-index-registry'

/**
 * Cross-process ContentId index generation marker.
 *
 * This is the ContentIdIndex-specific instance of the generic on-disk
 * generation-marker protocol in resource-generation.ts — see that module's
 * doc comment for the full protocol (random-token rationale, bump/read
 * ordering, and the general residual staleness windows A/B/C/E). This file
 * documents only what is specific to the in-memory ContentIdIndex.
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
 * The marker lives at {root}/.canopy-meta/content-index.generation.
 *
 * ## Residual staleness windows, as they apply here
 *
 * All bounded in practice by per-request ContentStore lifetimes and self-healed
 * by the suspicious-lookup backstop in ContentStore:
 *
 * - (A) NFS attribute caching: another host may not see a new marker for up to
 *   the attribute-cache timeout (~3-60s on default EFS mounts). The reader acts
 *   on a stale token and keeps a stale index until the cache expires.
 * - (B) Probe throttle: up to ContentStore's indexFreshnessIntervalMs (1s).
 * - (C) Self-adoption: after its own mutation a store adopts the token it
 *   wrote; if a concurrent foreign bump landed just before ours, we miss that
 *   one notification (window: from our last token observation to our rename).
 * - (E) Fresh-token/stale-scan (cross-host only): a rebuild's readdir calls may
 *   be served from stale dentry/attribute caches, recording a NEW token against
 *   PRE-mutation directory listings. Unlike a durable-snapshot consumer (see
 *   resource-generation.ts), this only mis-serves ONE process's in-memory
 *   index for the remainder of its lifetime — it is not written back to disk,
 *   so it cannot become a shared stale state visible to other hosts.
 *
 * Wrong-file WRITE corruption (recreating a concurrently renamed entry →
 * duplicate IDs) is prevented independently of this marker by the existence
 * guard in ContentStore.write(), which consults the actual directory listing
 * before recreating a missing expected file.
 */

const RESOURCE = 'content-index'

/** Absolute path of the generation marker for a branch-clone root. */
export function contentIndexGenerationPath(root: string): string {
  return resourceGenerationPath(root, RESOURCE)
}

/**
 * Record on disk that indexed files under `root` changed, so ContentStores in
 * OTHER processes rebuild. Must be called AFTER the filesystem mutation.
 * Returns the token written, or null if the write failed (logged and swallowed:
 * the content mutation is already durable; a lost bump degrades to the
 * pre-marker staleness behavior plus the ContentStore backstop).
 */
export async function bumpContentIndexGeneration(root: string): Promise<string | null> {
  return bumpResourceGeneration(root, RESOURCE)
}

/**
 * Read the current generation token for `root`. Returns null if the marker
 * does not exist yet (a valid state distinct from every token). Read errors
 * other than ENOENT are logged and treated as null — the caller then rebuilds,
 * which is the safe direction.
 */
export async function readContentIndexGeneration(root: string): Promise<string | null> {
  const result = await readResourceGeneration(root, RESOURCE)
  return result.ok ? result.token : null
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
