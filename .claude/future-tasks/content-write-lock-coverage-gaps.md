# [P1] Working-tree mutations still outside the content-write lock

Found while implementing [SYNC-C1] (the cross-host content-write lock,
`packages/canopycms/src/utils/content-write-lock.ts`), which closed the worker-rebase vs.
`ContentStore` race — finding 2 of
[baseline-2026-08-content-loss.md](resolved/baseline-2026-08-content-loss.md).

The lock is taken by `ContentStore.write`/`delete`/`renameEntry` and held by
`CmsWorker.rebaseActiveBranches()` for the whole rebase. Three adjacent things were left out
of that change deliberately (scope), and each is the same failure shape: a mutation the user
was told succeeded, reverted by a rebase that then reports success.

## 1. Schema mutations (`schema/schema-store.ts`, `SchemaOps`)

`createCollection`, `updateOrder`, `deleteCollection` and friends write `.collection.json`
files — and `deleteCollection` removes whole directory trees — in the same branch working
tree the worker rebases. They take the coarse per-branch `.canopy-meta/schema` surrogate
lock (layers 1+3), which serializes schema mutations against *each other* but not against
the rebase, because the rebase takes a different lock.

**Fix direction:** have `withSchemaLock` also take the content-write lock (outermost, to keep
one global acquisition order: content lock → schema surrogate → `withLock`), and translate a
`ContentWriteLockBusyError` into the existing `SchemaStoreBusyError` so api/schema.ts's 409
mapping keeps working unchanged. Check `cli/migrate.ts`, which takes the same surrogate lock
inside branch clones.

## 2. Asset writes (`assets/`)

The asset store's finalize pipeline writes into the branch working tree for the local
adapter. Same exposure; S3-backed deployments are unaffected.

## 3. Bulk tree mutations outside the worker

`sync-core.ts`, CLI `sync`, and `git-manager.ts`'s checkout/merge paths rewrite many files at
once. They already call `invalidateBranchContentCaches()`, which tells readers the tree
changed but does nothing to stop a concurrent save from being reverted. The recipe note in
`docs/concurrency.md` ("Bulk tree mutation") now says to take the lock; the existing call
sites have not been audited against it.

**Guard to add for each:** the pattern in
`packages/canopycms/src/worker/cms-worker-content-lock.test.ts` — drive the mutation with the
lock held and assert it fails retriably rather than proceeding.

## Also uncovered: `submitBranch` (added 2026-08-20)

Noted by the independent review of the proper-lockfile-hazards fix. `services.ts`'s
`submitBranch` is the **only** path that commits the working tree (`git.add('.')` +
commit + push), and it takes no content-write lock, so it can race the worker's rebase
in the same way the mutators above can. It is not an acute risk today -- the publish
side is keyed to the pre-rebase sha via `--force-with-lease`, so a colliding push is
refused rather than silently clobbering -- but it belongs on this list, because it is
the one place where a racing editor save could actually be *committed* rather than left
as dirty working-tree state.
