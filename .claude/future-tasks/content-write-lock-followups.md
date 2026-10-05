# [P3] Content-write lock follow-ups

Left after [content-write-lock-coverage-gaps.md](resolved/content-write-lock-coverage-gaps.md)
put every working-tree mutator under the branch's content-write lock.

## 1. Retire the schema surrogate lock

`withBranchSchemaLock` (`packages/canopycms/src/schema/schema-store.ts`) takes the
content-write lock and then the `.canopy-meta/schema` surrogate (`withLock` + `withOccFileLock`).
Every holder of the surrogate now holds the per-branch content-write lock first, so the
surrogate never excludes anything: cross-host the outer lock already does, and in-process a
second acquisition fails on the outer lock before `withLock`'s FIFO can queue it. It costs
extra EFS round-trips per schema mutation. Retire it, keep `OccWriteConflictError` handling
only if something still raises it, and update docs/concurrency.md's order and table row.

## 2. Dead `GitManager` tree mutators

`GitManager.pullBase()` and `rebaseOntoBase()` (`packages/canopycms/src/git-manager.ts`) have
no production callers, and both rewrite the working tree without the content-write lock.
Delete them with their tests, or lock them before anything calls them.
