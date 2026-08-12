# `approved` is a write-locked dead end with no UI exit

## Priority: P2

Found by the independent adversarial review of PR #189 (2026-08-12). The defect
is **pre-existing** (introduced with the status lock in `3f74e7fc`), not caused
by that PR — it was deliberately left out of #189's scope and filed here.

## Problem

Every non-`editing` status blocks content writes (`getBranchWriteProtection`),
which is correct. But `approved` is the only locked status with no
non-destructive way back:

- **Withdraw** requires `'submitted'` — `api/branch-withdraw.ts:42` rejects any
  other status with a 400.
- **Request changes** also requires `'submitted'` — `api/branch-review.ts:19`,
  same shape.

So an approved branch is frozen. Its only non-destructive exit is a raw
`workflow.submit` API call; there is no UI path at all.

Two things make it worse rather than merely awkward:

- `editor/components/EditorHeader.tsx:530-532` disables the action button on
  `approved` with a **misleading** tooltip — "You do not have permission to
  submit or withdraw". The user has the permission; the transition simply does
  not exist. This sends people to an admin to fix a non-permissions problem.
- `api/branch.ts:572` blocks deletion only for `'submitted'`, so an `approved`
  branch **with an open PR** is deletable — the destructive exit is the one
  that stayed open.

Reachability today is API-only: nothing in the editor calls `workflow.approve`,
so branches reach `approved` only via a direct API call or hand-edited
`branch.json`. That is why this is P2 rather than release-blocking — but the
approve endpoint is shipped and reviewer-callable, so it is reachable in prod.

## Decide

The shape of the fix depends on what `approved` is *for*, which is not settled:

- If `approved` means "reviewer signed off, awaiting merge", then withdraw
  should accept it (returning to `editing`), and delete should be blocked for it
  exactly as for `submitted`.
- If `approved` is vestigial — the worker archives on merge, and nothing in the
  product sets it — then consider deleting the literal, the way `'locked'` was
  deleted in #189. Check `pollMergeState` and the SystemHealthPanel's
  `canMarkMerged` (which reads `submitted || approved`) before removing.

Either way, fix the tooltip: a disabled control should say why.

## Files

- `packages/canopycms/src/api/branch-withdraw.ts:42`
- `packages/canopycms/src/api/branch-review.ts:19`
- `packages/canopycms/src/api/branch.ts:572` (delete rail)
- `packages/canopycms/src/editor/components/EditorHeader.tsx:530-532` (tooltip)

## Related

- [[submitted-branch-edit-locking]] (resolved) — established the status lock
- [[locked-branch-status-dead]] (resolved) — the decide-or-delete precedent
- [[content-lifecycle-scenarios]] — owns the broader workflow/UX question
