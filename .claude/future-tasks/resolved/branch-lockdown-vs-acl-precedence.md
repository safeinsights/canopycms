---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED 2026-10-14 — `checkBranchAccessWithDefault` applies the `managerOrAdminAllowed` lockdown before the ACL, through the shared, browser-safe `isLockedOutOfBranch` (`authorization/helpers.ts`), which the branch listing and the editor's Submit/Withdraw gating (`EditorHeader`, `getBranchPermissions`) now call too
---

# [P3] Branch ACL: enforce the manager/admin lockdown above an explicit ACL

## RESOLVED (2026-10-14)

The lockdown is a ceiling, checked once in `isLockedOutOfBranch` (`authorization/helpers.ts`).
`checkBranchAccessWithDefault` calls it ahead of the ACL, so every guard-based surface (reads,
writes, comments, Submit, Withdraw) follows it. The branch listing and both editor mirrors call
it too, because each kept its own copy of the old order. Tests cover the authorization layer, the
listing, both editor mirrors and the API end to end (`role-permissions.test.ts`). Follow-ups:
[branch-lockdown-unsettable-and-creator-rights.md](../branch-lockdown-unsettable-and-creator-rights.md).

JP ruled 2026-10-13 that the lockdown wins. The docs already say so: the "Precedence, highest
first" list on `checkBranchAccessWithDefault` in `packages/canopycms/src/authorization/branch.ts`,
`ARCHITECTURE.md` (The Permission Model) and `README.md` (branch access precedence). The code
disagrees: it denies on `managerOrAdminAllowed` only under `!hasUserConstraint &&
!hasGroupConstraint`, so with an ACL present the ACL decides and the lockdown never runs.

## Fix

- In `checkBranchAccessWithDefault`, deny a non-privileged user on `managerOrAdminAllowed` before
  the ACL is consulted, whatever the ACL lists.
- Add tests to `authorization/__tests__/branch.test.ts`: a lockdown plus an ACL naming the user
  (and one naming their group) denies; admins and reviewers still pass.
- `canPerformWorkflowAction` grants Submit and Withdraw on `allowed_by_acl`; once the lockdown
  denies first, an ACL-listed editor on a locked-down branch loses both, which is the ruling's
  intent.
  [authorization-enforcement-consolidation.md](../authorization-enforcement-consolidation.md) covers
  the ACL matchers' wider divergence.
