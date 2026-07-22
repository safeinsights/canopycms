# schema-store.ts: .collection.json read-modify-write has no OCC/lockfile protection

## Priority: P2

Surfaced by the EFS cross-process concurrency epic's second review (2026-07-21), while
implementing fixes from a follow-up adversarial review of that epic's PRs. Not part of
the epic's original scope (see `resolved/efs-cross-process-concurrency.md`), which covered
branch-registry, branch-schema-cache, comment-store, branch-metadata, and content-store
lock keys — `.collection.json` writes were left as-is.

## Problem

`SchemaOps` in `packages/canopycms/src/schema/schema-store.ts` mutates `.collection.json`
files with a classic read-modify-write:

```ts
const meta = await this.readCollectionMeta(collectionPath) // no lock
// ...mutate `meta` in memory (add/remove/rename an entry, field, etc.)...
await this.writeCollectionMeta(physicalPath, meta) // withLock covers ONLY this call
```

`writeCollectionMeta()` / `writeRootCollectionMeta()` wrap just the final
`atomicWriteFile()` call in `withLock(metaPath, ...)` (see schema-store.ts's Write
Operations section). That serializes concurrent *writes* against each other within one
process, but does nothing for the read-modify-write window: two concurrent schema
mutations on the same collection (e.g. two admins each adding a different field, or an
API request racing a CLI `migrate`) can both read the same pre-mutation `meta`, both
mutate their own in-memory copy, and the second `writeCollectionMeta()` call silently
clobbers the first mutation — a lost update, cross-process on EFS and even same-process
if the two calls interleave around the unlocked read.

This is exactly the read-modify-write pattern `docs/concurrency.md`'s "Adding a mutable
JSON file" recipe exists for (`withLock` + `writeOccJsonFile` + `withOccRetry`, plus
`withOccFileLock` when a cross-host lost update is unacceptable) — reference
implementations `comment-store.ts` and `branch-metadata.ts` both follow it.
`.collection.json` currently doesn't.

## Scope

- `packages/canopycms/src/schema/schema-store.ts` — `readCollectionMeta`,
  `writeCollectionMeta`, `writeRootCollectionMeta`, and every mutator that composes them
  (`createCollection`, `updateCollection`, `deleteCollection`, and the entry-type/field
  mutators around lines 640-780)

## Fix sketch

Follow the standard recipe:

1. Add a `version` (+ `writeId`) field to the `.collection.json` payload shape (or reuse
   `writeOccJsonFile`/`withOccRetry` from `utils/occ-json-write.ts` directly, mirroring
   `comment-store.ts`).
2. Wrap the full read-modify-write cycle in `withLock(metaPath)`, not just the write —
   and reload `meta` fresh at the top of the locked callback (`withOccRetry`'s operation
   is expected to reload state on every attempt).
3. Decide whether cross-host lost updates are tolerable here. Schema mutations are
   admin-only and relatively rare (unlike per-keystroke content saves), so OCC alone
   (layer 2) might be an acceptable choice — but if two admins editing schema
   simultaneously on different Lambda containers is a real scenario worth protecting,
   add `withOccFileLock` (layer 3) as branch-metadata.ts and comment-store.ts do.
4. Translate any internal `OccWriteConflictError` to a `SchemaOps`-level public error
   **after** retries are exhausted, never inside the write path (concurrency.md flags
   this exact bug class as previously caught in review).

## Related

- `docs/concurrency.md` — "Adding a mutable JSON file" recipe
- `resolved/efs-cross-process-concurrency.md` — the epic that hardened branch-registry,
  branch-schema-cache, comment-store, branch-metadata, and content-store, but did not
  touch schema-store.ts
