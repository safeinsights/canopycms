import path from 'node:path'

/**
 * In-process registry connecting branch-mutating operations (git checkout/merge/rebase,
 * content sync) to the ContentStore instances whose ContentId indexes those operations
 * make stale.
 *
 * ContentStore registers itself (keyed by its resolved root) on construction. Operations
 * that change files under a root — GitManager working-tree mutations, the worker's rebase
 * loop, sync-core's content replacement — call invalidateContentIndexesForRoot() so the
 * next index access rebuilds from disk instead of serving stale ID→path mappings.
 *
 * SCOPE: in-process only. Two processes (e.g. Lambda + worker on shared EFS) each have
 * their own registry; a mutation in one process cannot invalidate indexes in another.
 * Cross-process divergence is a separate, still-open issue.
 *
 * Stores are held via WeakRef so short-lived (per-request) instances can be garbage
 * collected; a FinalizationRegistry prunes dead entries.
 */

/** Anything holding a rebuildable content index (in practice: ContentStore). */
export interface InvalidatableContentIndex {
  invalidateIndex(): void
}

const registry = new Map<string, Set<WeakRef<InvalidatableContentIndex>>>()

const finalization = new FinalizationRegistry<{
  rootKey: string
  ref: WeakRef<InvalidatableContentIndex>
}>(({ rootKey, ref }) => {
  const refs = registry.get(rootKey)
  if (!refs) return
  refs.delete(ref)
  if (refs.size === 0) registry.delete(rootKey)
})

/**
 * Register a content-index holder for invalidation when files under `root` change.
 * Called by the ContentStore constructor.
 */
export function registerContentIndexForInvalidation(
  root: string,
  target: InvalidatableContentIndex,
): void {
  const rootKey = path.resolve(root)
  let refs = registry.get(rootKey)
  if (!refs) {
    refs = new Set()
    registry.set(rootKey, refs)
  }
  const ref = new WeakRef(target)
  refs.add(ref)
  finalization.register(target, { rootKey, ref })
}

/**
 * Invalidate every registered content index rooted at `root` or below it.
 * Prefix matching covers stores rooted at a subdirectory of the mutated repo
 * (e.g. a store rooted at a branch clone inside a mutated workspace tree).
 *
 * Invalidation only marks indexes stale; the rebuild happens lazily on the next
 * index access, so calling this for a root with no live stores is free.
 */
export function invalidateContentIndexesForRoot(root: string): void {
  const rootKey = path.resolve(root)
  const prefix = rootKey + path.sep
  for (const [storeRoot, refs] of registry) {
    if (storeRoot !== rootKey && !storeRoot.startsWith(prefix)) continue
    for (const ref of refs) {
      const target = ref.deref()
      if (target) {
        target.invalidateIndex()
      } else {
        refs.delete(ref)
      }
    }
    if (refs.size === 0) registry.delete(storeRoot)
  }
}
