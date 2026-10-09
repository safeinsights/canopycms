---
summary: >-
  RESOLVED 2026-10-05, branch `fix/content-write-lock-coverage`, base `int-202610-a`. Every working-tree mutator a rebase could revert now takes the [SYNC-C1] content-write lock: `SchemaOps` and CLI migrate (via `withBranchSchemaLock`, still 409), `submitBranch` and `commitFiles` from checkout through push, CLI sync's replace/merge/abort, and the worker's base-branch refresh (try-only). Assets are branch-agnostic and outside every clone, so not exposed. One global acquisition order is documented in docs/concurrency.md
---
# [P1] Working-tree mutations still outside the content-write lock

## Resolution (2026-10-05, branch `fix/content-write-lock-coverage`, base `int-202610-a`)

Every working-tree mutator the rebase could revert now takes the lock; the full list and the
one global acquisition order are in docs/concurrency.md ("Who takes it", "Lock acquisition
order"). Each acquisition has a held-lock test that fails retriably with the tree untouched,
plus a positive control, all verified red first and mutation-checked.

1. **Schema.** `withBranchSchemaLock` (schema/schema-store.ts) takes the content-write lock,
   then the `.canopy-meta/schema` surrogate. `SchemaOps` maps contention to
   `SchemaStoreBusyError`, so api/schema.ts's 409 is unchanged, and still invalidates the
   schema cache when the lock is lost after the mutation landed. CLI migrate uses the same
   helper in a branch clone.
2. **Assets: not exposed.** The store is branch-agnostic and rooted outside every branch
   clone (assets/factory.ts), so the rebase never touches it. No lock.
3. **Bulk mutations.** CLI sync push (`pushContentToWorkspace`, now including the
   editor-state commit), `sync both` (the whole merge) and every merge-abort path take it;
   the worker's base-branch refresh takes it try-only (`skipped-locked`). GitManager's
   `checkoutBranch` runs either under provisioning (already exclusive with the rebase) or
   from `submitBranch`; `pullCurrentBranch` is settings-workspace only.
4. **`submitBranch` takes it**, checkout through push: unlocked, its checkout succeeds while
   the rebase is stopped on a conflict, the commit lands on the branch, and the rebase's
   `--abort` resets the branch past it after the submit reported success (measured). `commitFiles` takes it too. api/branch-status.ts maps contention
   to a 409 worded by `ContentWriteLockBusyError.outcome`.

Follow-ups: [content-write-lock-followups.md](../content-write-lock-followups.md).

Found while implementing [SYNC-C1] (the cross-host content-write lock,
`packages/canopycms/src/utils/content-write-lock.ts`), which closed the worker-rebase vs.
`ContentStore` race — finding 2 of
[baseline-2026-08-content-loss.md](baseline-2026-08-content-loss.md).

The lock is taken by `ContentStore.write`/`delete`/`renameEntry` and held by
`CmsWorker.rebaseActiveBranches()` for the whole rebase. Three adjacent things were left out
of that change deliberately (scope), and each is the same failure shape: a mutation the user
was told succeeded, reverted by a rebase that then reports success.

## 1. Schema mutations (`schema/schema-store.ts`, `SchemaOps`)

`createCollection`, `updateOrder`, `deleteCollection` and friends write `.collection.json`
files — and `deleteCollection` removes whole directory trees — in the same branch working
tree the worker rebases. They take the coarse per-branch `.canopy-meta/schema` surrogate
lock (layers 1+3), which serializes schema mutations against _each other_ but not against
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
the one place where a racing editor save could actually be _committed_ rather than left
as dirty working-tree state.
