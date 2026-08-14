# `approved`: exit and delete rail both fixed; only "is it vestigial?" is open

## Priority: P3 (was P2 — the dead end itself is fixed)

Found by the independent adversarial review of PR #189 (2026-08-12). The defect
is **pre-existing** (introduced with the status lock in `3f74e7fc`), not caused
by that PR — it was deliberately left out of #189's scope and filed here.

## Fixed by the submit status gate PR (2026-08-13)

That PR closed the submit path's missing status gate, which had a direct bearing
on this file: the "only non-destructive exit is a raw `workflow.submit` call"
noted below was not just a hack, it **silently discarded the approval** by
re-stamping the branch `submitted`. Closing that hole would have sealed this dead
end completely, so the exit was opened in the same PR:

- **Withdraw now accepts `approved`** as well as `submitted`
  (`api/branch-withdraw.ts`), returning the branch to `editing`.
- **The UI surfaces it**: `BranchManager.tsx`'s `canWithdraw` and
  `EditorHeader.tsx`'s action button both treat `approved` as withdrawable.
  (The server accepting it is not enough — without this there is still no UI path.)
- **The misleading tooltip is fixed**: a status with no available transition
  (today only `archived`) now says so, instead of claiming the user lacks
  permission.

## Still open

**1. Is `approved` vestigial?** Unchanged and still undecided. Nothing in the
editor calls `workflow.approve`, so branches reach `approved` only via a direct
API call or a hand-edited `branch.json`. Either:

- `approved` means "reviewer signed off, awaiting merge" — then it needs a real
  UI affordance for reviewers, and the delete rail below needs fixing; or
- it is vestigial — then consider deleting the literal, the way `'locked'` was
  deleted in #189. Check `pollMergeState` and the SystemHealthPanel's
  `canMarkMerged` (which reads `submitted || approved`) before removing.

Note the withdraw change above is compatible with either answer: if the literal
is deleted, the `|| status === 'approved'` clauses go with it.

~~**2. The delete rail still lets an approved branch with an open PR be
deleted.** `api/branch.ts:572` blocks deletion only for `'submitted'`.~~
**RESOLVED 2026-08-13** by `8bce5a09` ("a reviewed, approved branch could be
destroyed by one unconfirmed click"), which landed later the same day this file
was last edited — hence the stale text above. `api/branch.ts:637` now blocks
deletion for `'submitted' || 'approved'`, with the reasoning recorded in-code at
`:622-636`; a confirmation modal and a corrected delete tooltip were added
client-side (`BranchManager.tsx:600-615`). No destructive-exit asymmetry remains.

## Files

- ~~`packages/canopycms/src/api/branch.ts:572` (delete rail)~~ → fixed, now
  `api/branch.ts:637`
- `packages/canopycms/src/api/branch-review.ts:19` (request-changes still
  requires `'submitted'`; deliberate — withdraw is the general exit)
- `packages/canopycms/src/api/branch-review.ts:103` + `api/client.ts:124` —
  `approveBranch` / `workflow.approve` exist server-side with **no editor caller**
  (grep across `editor/` and `apps/`), which is the evidence for item 1

## Related

- [[submitted-branch-edit-locking]] (resolved) — established the status lock
- [[locked-branch-status-dead]] (resolved) — the decide-or-delete precedent
- [[content-lifecycle-scenarios]] — owns the broader workflow/UX question
