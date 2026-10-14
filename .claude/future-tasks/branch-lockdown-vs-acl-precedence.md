---
priority: P3
adopters: BOTH
summary: >-
  JP 2026-10-13: the `managerOrAdminAllowed` lockdown outranks an explicit branch ACL, as `authorization/branch.ts`'s doc comment, ARCHITECTURE.md and README.md already say. The code runs the lockdown only when no user or group ACL exists, so an ACL naming an editor still lets them in; make the code enforce the lockdown above any ACL, with tests
---

# [P3] Branch ACL: enforce the manager/admin lockdown above an explicit ACL

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
  [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md) covers
  the ACL matchers' wider divergence.
