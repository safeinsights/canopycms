# Schema Cache Invalidation on Branch Sync

## Problem

When branch sync code pulls changes from remote git repository, `.collection.json` files may have changed. The schema cache needs to be invalidated so the next schema load reflects the pulled changes.

## Solution

In the branch sync/pull implementation, after pulling changes:

```typescript
// After git pull in branch sync code
await git.pull()

// Invalidate schema cache by writing stale marker
const cacheStale = path.join(branchRoot, '.canopy-meta', 'schema-cache.stale')
await fs.writeFile(cacheStale, '', 'utf-8')
```

Or simply delete the cache file:

```typescript
const cachePath = path.join(branchRoot, '.canopy-meta', 'schema-cache.json')
try {
  await fs.unlink(cachePath)
} catch {
  // Cache might not exist - that's fine
}
```

## Implementation Details

The schema cache uses a stale marker pattern:

- Cache file: `{branchRoot}/.canopy-meta/schema-cache.json`
- Stale marker: `{branchRoot}/.canopy-meta/schema-cache.stale`

When the stale marker exists, `SchemaCacheRegistry.getSchema()` regenerates the cache on next access.

## Related Files

- Schema cache implementation: `packages/canopycms/src/schema-cache-registry.ts`
- Cache invalidation method: `SchemaCacheRegistry.invalidate(branchRoot)`
- Schema store (already invalidates on mutations): `packages/canopycms/src/schema/schema-store.ts`

## When to Implement

When branch sync/pull functionality is implemented for keeping branch clones in sync with remote changes.
