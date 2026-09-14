import {
  resourceGenerationPath,
  bumpResourceGeneration,
  readResourceGeneration,
} from './resource-generation'
import { invalidateContentIndexesForRoot } from './content-index-registry'
import { SCHEMA_GENERATION_RESOURCE } from './branch-schema-cache'

/**
 * The ContentIdIndex instance of the generation-marker protocol owned by
 * resource-generation.ts; the marker lives at
 * {root}/.canopy-meta/content-index.generation. In-process invalidation of the
 * same indexes is content-index-registry.ts's job.
 *
 * Local to this consumer: the index is per-ContentStore memory, never persisted,
 * so a scan that records a fresh token over stale NFS-cached readdir results
 * mis-serves only that one process for the rest of its lifetime — it cannot
 * become shared stale state the way a durable snapshot can.
 *
 * Wrong-file WRITE corruption (recreating a concurrently renamed entry →
 * duplicate IDs) is prevented independently of this marker by the existence
 * guard in ContentStore.write(), which consults the actual directory listing
 * before recreating a missing expected file.
 */

const RESOURCE = 'content-index'

/**
 * Absolute path of the generation marker for a branch-clone root.
 * @internal No importer; deletion candidate in knip-no-importer-deletion-candidates.md.
 */
export function contentIndexGenerationPath(root: string): string {
  return resourceGenerationPath(root, RESOURCE)
}

/**
 * Record on disk that indexed files under `root` changed, so ContentStores in
 * OTHER processes rebuild. Must be called AFTER the filesystem mutation.
 * Returns the token written, or null if the write failed — a hint bump, since
 * the content mutation is already durable and ContentStore has a backstop.
 */
export async function bumpContentIndexGeneration(root: string): Promise<string | null> {
  return bumpResourceGeneration(root, RESOURCE)
}

/**
 * Read the current generation token for `root`. Null means the marker does not
 * exist yet; a read error collapses to null too, so the caller rebuilds, which
 * is the safe direction.
 */
export async function readContentIndexGeneration(root: string): Promise<string | null> {
  const result = await readResourceGeneration(root, RESOURCE)
  return result.ok ? result.token : null
}

/**
 * The entry point for a bulk mutation site that touches indexed files under a
 * branch-clone root broadly but never touches schema. No production caller yet:
 * `ContentStore`'s write/delete/renameEntry bump the marker directly via
 * `recordOwnMutation()`, and every bulk site (git checkout/merge/rebase, sync,
 * CLI sync, migrate) can touch `.collection.json` as a side effect, so those
 * take `invalidateBranchContentCaches()` below.
 *
 * Bump BEFORE invalidating: the rebuild the invalidation triggers captures the
 * marker token before scanning, so the new token lands in that same pass
 * instead of costing a second rebuild.
 */
export async function invalidateContentIndexesDurable(root: string): Promise<void> {
  await bumpContentIndexGeneration(root)
  invalidateContentIndexesForRoot(root)
}

/**
 * The entry point for operations that mutate a branch-clone root's working tree
 * broadly: git working-tree ops (checkout/merge/rebase/abort), content sync,
 * CLI sync, migrate. Those can touch `.collection.json` as a side effect (a
 * rebase pulls in upstream schema changes; a sync overwrites the whole content
 * directory), so BOTH caches rooted at `root` are bumped — the ContentId index
 * and the resolved-schema cache.
 *
 * Both bumps are hint flavor (no `mustSucceed`): these callers are typically
 * `finally` blocks in bulk operations, which must not start throwing because a
 * marker write failed.
 */
export async function invalidateBranchContentCaches(root: string): Promise<void> {
  await bumpContentIndexGeneration(root)
  await bumpResourceGeneration(root, SCHEMA_GENERATION_RESOURCE)
  invalidateContentIndexesForRoot(root)
}
