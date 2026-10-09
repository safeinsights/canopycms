---
priority: P3
adopters: BOTH
summary: >-
  **Decided:** remove the unused `approved` status. Nothing in the editor calls `workflow.approve`, so branches reach it only by a direct API call or a hand-edited `branch.json`; the file lists every place that reads it
---
# Remove the unused `approved` branch status

**Priority: P3 [BOTH].**

**Decided:** remove the unused `approved` status. This is new code with no compat need, and every
unused state is a guard branch to keep correct.

## Evidence it is unused

Nothing in the editor calls `workflow.approve`; `approveBranch` / `workflow.approve` exist
server-side (`api/branch-review.ts:103`, `api/client.ts:124`) with no editor caller (grep across
`editor/` and `apps/`). Branches reach `approved` only via a direct API call or a hand-edited
`branch.json`.

## What removal touches

Delete the `BranchStatus` member (`types.ts`), the approve endpoint and client method, and every
`|| status === 'approved'` clause. The places that read it:

- `api/branch-review.ts` (approve handler; request-changes requires `submitted`).
- `api/branch-withdraw.ts` (withdraw accepts `submitted` and `approved`).
- `api/branch-merge.ts` (`markAsMerged` accepts `submitted` and `approved`).
- `api/branch.ts` delete rail (blocks deletion for `submitted` and `approved`).
- `worker/rebase.ts` (the active-PR skip).
- `BranchManager.tsx`, `EditorHeader.tsx` (withdraw affordances) and `admin/SystemHealthPanel.tsx`
  (rebase-failure and mark-merged checks).

Precedent: `'locked'` was deleted the same way ([locked-branch-status-dead](resolved/locked-branch-status-dead.md)).

## Related

- [submitted-branch-edit-locking](resolved/submitted-branch-edit-locking.md): established the status lock
- [content-lifecycle-scenarios](content-lifecycle-scenarios.md): owns the broader workflow/UX question
