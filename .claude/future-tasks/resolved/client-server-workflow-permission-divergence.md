# Client permission model grants the branch creator unconditionally; the server requires general branch access first

## Status: RESOLVED 2026-08-14 — server changed to match the client

Found 2026-08-13 state-space-mapping the composed diff for the review-followups
epic. Fixed on `fix/acl-defaults-and-creator-grant` (off `integration-202608-b`)
as the prerequisite half of
[acl-defaults-and-dead-path-checker.md](acl-defaults-and-dead-path-checker.md).

## The problem

The client granted the branch **creator** unconditionally
(`BranchManager.tsx` ~101-115, `EditorHeader.tsx` ~537-549), while the server's
`canPerformWorkflowAction` ran `checkBranchAccessWithDefault` **first** and
returned false before creator status was considered. Under
`defaultBranchAccess: 'deny'` the creator of a branch with no ACL — the create
form sends none — saw an enabled Submit/Withdraw and got a 403.

## Resolution

**The server was wrong, and it was wrong more broadly than this file recorded.**
The divergence was not confined to workflow actions: `checkBranchAccessWithDefault`
is ANDed into every content check by `createContentAccessChecker`, so the same
gap meant a creator could not read or write a single file on their own branch
under `'deny'` — the Submit button was the visible symptom, not the defect.

The fix therefore went in at `checkBranchAccessWithDefault` rather than in
`canPerformWorkflowAction`: the creator of an un-ACL'd branch is now granted
access there (`reason: 'creator'`), so the guards, the content layer and the
workflow check all agree. `canPerformWorkflowAction` needed no logic change — it
already tested `userIsCreator` separately; the gate above it was simply
swallowing creators before that test could run.

Choosing the server side also matched what the server already did in three other
places (`listBranchesHandler`, `canDeleteBranch`, `canModifyBranchAccess`), all
of which grant on creator-ownership independently of branch access. The
divergence was an internal inconsistency, not a policy someone had chosen.

## Scope deliberately NOT taken

The grant is limited to branches with **no ACL**. An explicit allowlist that
omits the creator still denies them. An earlier draft granted creator ahead of
the ACL and was caught by `role-permissions.test.ts`: it silently defeated an
**admin** locking down a branch that an editor had created. The client's mirrors
were left as-is — they now agree with the server for the no-ACL case, and the
ACL case was already consistent.

## Related

- `packages/canopycms/src/authorization/branch.ts` — `canPerformWorkflowAction`,
  `checkBranchAccessWithDefault`
- [acl-defaults-and-dead-path-checker.md](acl-defaults-and-dead-path-checker.md)
  — the task this unblocked
