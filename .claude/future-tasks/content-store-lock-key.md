# ContentStore: Use Content ID as Stable Lock Key

## Problem

`ContentStore.write()`, `delete()`, and `renameEntry()` currently lock on `absolutePath` (the
physical file path). `buildPaths()` — which resolves the physical path by directory-scanning for
the slug — is called **outside** the lock, so the lock key can be stale:

1. `write(collection, slug=foo)` calls `buildPaths()` → resolves `post.foo.abc123.json`
2. Concurrently, `renameEntry(collection, foo → bar)` completes → file is now `post.bar.abc123.json`
3. `write` acquires lock on `.../post.foo.abc123.json` (the old, now-gone path)
4. `atomicWriteFile` creates a new file at the old path → **two files with id `abc123`**, slug
   uniqueness violated

## Scope

- `packages/canopycms/src/content-store.ts` — `write()`, `delete()`, `renameEntry()`

## Fix

Use the **content ID** (embedded in the filename as `{type}.{slug}.{id}.{ext}`) as the lock key.
The ID never changes even when an entry is renamed — it's permanently assigned on creation. This
makes the lock key immune to renames.

### write() and delete()

Look up the entry's ID via the index (or from `buildPaths()`) **before** acquiring the lock. Then
lock on the ID and move `buildPaths()` inside the lock (to get the current physical path after lock
acquisition):

```ts
// Stable lock key = content ID (permanent, survives rename)
// Only applies to existing entries — new entry creates each produce a unique ID
// and write to distinct files, so they have no shared resource to contend on.
const existingId = idIndex.findByPath(/* relativePath from a pre-scan */)
if (existingId) {
  return withLock(existingId, async () => {
    const { absolutePath, relativePath } = await this.buildPaths(schemaItem, slug, {
      entryTypeName,
    })
    // ... rest of write body
  })
}
// New entry: no existing resource to lock on; generate ID and write directly
```

### renameEntry()

Since the content ID is invariant under rename, `renameEntry` only needs **one lock** (on the
entry's ID) — no two-key locking required:

```ts
const id = idIndex.findByPath(currentRelPath)
return withLock(id, async () => {
  // ... buildPaths, readdir uniqueness check, link()+unlink()
})
```

This also serializes concurrent `write()` + `renameEntry()` on the same entry since both use the
same lock key.

### .collection.json (schema-store.ts)

No change needed — collections are not renamed via `renameEntry()`, so `absolutePath` is already
a stable key for `.collection.json` writes.

## Notes

- `buildPaths()` must move inside the lock for writes/deletes on existing entries (currently
  outside for "validation errors surface immediately" — acceptable tradeoff for correctness)
- New entry creates each produce a unique ID and write to distinct files — no shared resource,
  no lock needed
- The in-process mutex already handles the most common case; this fixes the rename-race edge case
- Related: `index-staleness-multiprocess.md` — cross-process index divergence after git ops

## Related

- `content-store-locking.md` — parent task (mutex + OCC, now complete)
- Review finding HIGH-2 from 2026-04-11 branch review
