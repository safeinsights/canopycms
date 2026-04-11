# ContentStore Concurrent Write Locking

## Problem

`ContentStore.write()` is async and non-reentrant. Two concurrent requests on the same branch editing the same entry interleave:

1. Request A reads fields → builds document → `atomicWriteFile` → `updateIdIndex`
2. Request B reads fields → builds document → `atomicWriteFile` → `updateIdIndex`

Both writes are byte-level atomic (temp + rename), but the _logical_ write is not serialized. Last-writer-wins with no indication of conflict. In the documented prod deployment (EFS + multiple simultaneous editors per branch), this is a real data-loss scenario.

The same race exists on:

- `ContentStore.delete()` — unlink then index remove
- `ContentStore.renameEntry()` — readdir check then fs.rename (Linux rename overwrites silently)

The `ContentIdIndex` mutation (add/remove/updatePath) also has no guard, so index state can diverge from disk state mid-operation.

## Scope

- `packages/canopycms/src/content-store.ts` — `write()`, `delete()`, `renameEntry()`
- `packages/canopycms/src/content-id-index.ts` — index mutations
- `packages/canopycms/src/utils/` — may need a new per-key async mutex utility

## Proposed Approach

### 1. Per-absolute-path async mutex for in-process serialization

```ts
// utils/async-mutex.ts
const locks = new Map<string, Promise<void>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  locks.set(key, next)
  await prev
  try {
    return await fn()
  } finally {
    resolve()
    if (locks.get(key) === next) locks.delete(key)
  }
}
```

Wrap `write()`, `delete()`, and `renameEntry()` in `withLock(absoluteFilePath, ...)`.

### 2. OCC token for cross-process conflict detection

Pass `expectedVersion` (file mtime or content hash) through `WriteInput`. On write, stat the file before `atomicWriteFile`; if mtime differs from expected, throw a `ContentConflictError` (409). Mirror the pattern from `BranchMetadataFileManager`.

The API handler returns 409; the editor retries with a merge dialog (future UX work).

### 3. `renameEntry` atomicity

Replace the readdir-then-rename race with `link(src, dst)` (fails with EEXIST) + `unlink(src)`. This prevents silent overwrite of concurrent creates.

## Impact

- **High priority** — must be addressed before multi-editor prod usage
- Medium implementation effort (~2 days)
- No adopter-visible API changes

## Files to Touch

- `packages/canopycms/src/content-store.ts`
- `packages/canopycms/src/content-id-index.ts`
- `packages/canopycms/src/utils/async-mutex.ts` (new)
- `packages/canopycms/src/api/content.ts` (return 409 on ContentConflictError)
- `packages/canopycms/src/editor/hooks/useDraftManager.ts` (handle 409 from save)

## Related

- `index-staleness-multiprocess.md` — cross-process index consistency
- Review report: CRIT-1, CRIT-2, COMPOUND-4
