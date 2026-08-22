# [P3] `AU` and `DD` conflict codes take the abort path where keep-branch-version has an answer

Found by the human review of PR #257 (2026-08-22), rated low. Successor to the
modify/delete work in
[resolved/infra-review-2026-08-rebase-wedge-recovery.md](resolved/infra-review-2026-08-rebase-wedge-recovery.md).

## The gap

`rebaseActiveBranches`' conflict-resolution table handles `UD` (branch deleted →
`git rm`) and `DU` (base deleted, branch modified → `git add`), with
`git checkout --theirs` for everything else.

Two other unmerged codes have no stage-3 blob either, so `checkout --theirs`
fails on them the same way:

- **`AU`** — "added by us"
- **`DD`** — "both deleted"

Since the epic's fix, these no longer *wedge* the clone: any per-file resolution
failure routes into the `!completed` path, which aborts the rebase and records a
sync failure. That is a large improvement, and the code comment says unhandled
failures route there deliberately. But for both codes the keep-branch-version
resolution is the same `git rm` that `UD` already gets, so the branch takes an
avoidable failed sync.

The wedge test covers `UD`, `DU` and ordinary `UU` only.

## Related, and already disclosed in the code

A clone that crashed mid-rebase and then had its status moved off `editing` is
never revisited by the rebase loop — the status filter runs before the recovery
step. `BranchHealthEntry.rebaseInProgress` surfaces it and nothing fixes it. This
is called out in that field's own doc comment, in `CODEBASE_GUIDE.md` and in
`docs/concurrency.md`; recorded here because it is the one path where the P1 fix
is detection-only.

## Fix direction

Extend the conflict-kind dispatch to `AU`/`DD` with the same `git rm`, and add
fixtures for both to `cms-worker-rebase-wedge.test.ts`. Verify the direction
against real git first rather than reasoning it out — that is how the `UD`/`DU`
directions were established, and getting one backwards silently resurrects or
deletes an editor's file.
