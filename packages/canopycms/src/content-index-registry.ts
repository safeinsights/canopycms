import path from 'node:path'

/**
 * In-process registry connecting branch-mutating operations to the ContentStore
 * instances whose ContentId indexes they make stale. ContentStore registers
 * itself on construction, keyed by its resolved root; a mutation site calls
 * invalidateContentIndexesForRoot() so the next index access rebuilds from disk
 * instead of serving stale ID→path mappings.
 *
 * SCOPE: in-process only, the zero-latency half. Cross-process divergence is the
 * generation marker's job (content-index-generation.ts), and mutation sites
 * should call invalidateContentIndexesDurable() there, which does both.
 *
 * Stores are held via WeakRef so per-request instances can be collected; a
 * FinalizationRegistry prunes dead entries.
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

/** Register a holder for invalidation when files under `root` change. */
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
 * Invalidate every registered index rooted at `root` or below it; the prefix
 * match covers a store rooted at a subdirectory of the mutated repo.
 *
 * This only marks indexes stale — the rebuild is lazy, on next access — so a
 * root with no live stores costs nothing.
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
