---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-14. The `managerOrAdminAllowed` branch lockdown is enforced everywhere but no API or UI sets it (only a hand edit of `branch.json`), and a locked-out creator can still delete the branch and rewrite its now-inert ACL. Decide: build lockdown as a real admin feature, or delete it as `adminOnly` was
---

# Branch lockdown: nothing sets it, and the creator keeps delete rights

[branch-lockdown-vs-acl-precedence.md](resolved/branch-lockdown-vs-acl-precedence.md) made the
lockdown a ceiling over the ACL. Two gaps remain, and both need a decision from JP.

## 1. No API or UI sets `managerOrAdminAllowed`

`updateBranchAccessBodySchema` and `createBranchBodySchema` (`api/branch.ts`) accept only
`allowedUsers` and `allowedGroups`, and the editor has no control for it, so the only way to lock
a branch is to edit its `branch.json` by hand. `adminOnly` was deleted for this reason
([admin-only-acl-unenforced.md](resolved/admin-only-acl-unenforced.md)). The tests that send
`managerOrAdminAllowed` in a PATCH body (`__integration__/workflows/api-editing-workflow.test.ts`)
have it stripped by zod without noticing.

- **Build it:** an admin-only body field on `PATCH /:branch/access` (a creator must not be able to
  lift a lockdown an admin set), a control in the branch access UI, tests.
- **Or delete it:** the field, `isLockedOutOfBranch`, and the precedence line in ARCHITECTURE.md and
  README.md.

## 2. A locked-out creator can still delete the branch

`canDeleteBranch` and `canModifyBranchAccess` (`api/branch.ts`) grant the creator without
consulting branch access. On a locked branch the creator cannot read it, but can still delete it
and rewrite its ACL. The ACL rewrite is harmless now, since the lockdown outranks it. Whether the
delete grant should yield to a lockdown is a ruling to make, and `getBranchPermissions`'
`canDelete` (`editor/BranchManager.tsx`) has to change with it.
