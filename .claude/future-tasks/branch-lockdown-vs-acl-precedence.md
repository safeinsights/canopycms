# [P2] Branch ACL: the manager/admin lockdown is documented above an explicit ACL but runs only without one

**Status:** Open. Filed 2026-09-14 from the manager's review of the A2 comment-compression PR in
[baseline-quality-202609.md](resolved/baseline-quality-202609.md). Decide it alongside
[authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md), which
already covers the ACL matchers' divergence.

## The disagreement

`packages/canopycms/src/authorization/branch.ts` (`checkBranchAccessWithDefault`, doc comment at
lines 33-44) heads its list "Precedence, highest first" and ranks the `managerOrAdminAllowed`
lockdown (2) above an explicit user/group ACL (3). The code applies the lockdown only when neither
a user nor a group constraint exists (`!hasUserConstraint && !hasGroupConstraint &&
managerOrAdminAllowed`), so with an ACL present the ACL decides and the lockdown never runs. The
two are disjoint in the code and ranked in the prose.

The comment was left byte-identical on purpose: the compression epic's rule is that a comment
contradicting the code stays untouched and becomes a task.

## Decision needed (JP)

- (a) The code is right: an explicit ACL is the finer instrument and wins. Then the doc's list
  becomes "either an ACL decides, or, with no ACL, the lockdown does".
- (b) The comment is right: a manager/admin-only lockdown must override an ACL that names an
  editor. Then the branch changes, and the tests beside it in `authorization/` with it.

Either way the doc and the code must say the same thing afterwards, and so must the two docs that
restate the lockdown-above-ACL ordering: `ARCHITECTURE.md` (The Permission Model, the branch-ACL
precedence list, around line 375) and `README.md` (branch access precedence, around line 1452).
