# `BranchAccessControl.adminOnly` is defined but never enforced

## RESOLVED (2026-08-12) — deleted the field

Decided delete rather than enforce. The field had exactly one occurrence
repo-wide (its own declaration in `types.ts`), and crucially it was not even
*settable*: `updateAccess`'s body schema accepts only `allowedUsers` and
`allowedGroups`, so no caller could ever populate it. The "silently ignored
access-control field" risk this file described was therefore latent rather than
live — nothing could set it and then be surprised.

Enforcing a field no API can set would have been dead weight. Admin-only
branches, if wanted, should be built deliberately as a feature: a body-schema
field, enforcement in `checkBranchAccessWithDefault`, UI, and tests.

Confirmed during the git-admin-observability epic's exploration (2026-07-24).

## Problem

`types.ts` declares `adminOnly?: boolean` on `BranchAccessControl`, but no code
reads it — grep finds only the declaration. A branch creator could set it via
the ACL API expecting admin-only access and get no enforcement whatsoever.
Security-adjacent: a silently-ignored access-control field is worse than a
missing one.

## Decide

- If wanted: enforce in `authorization/branch.ts` (alongside
  `managerOrAdminAllowed`) + surface in the branch-creation/ACL UI + tests.
- If not: delete the field and let the compiler flag latent references.

Same decide-or-delete shape as `locked-branch-status-dead.md` (the other dead
enum/field from this sweep) — consider handling both in one pass.

## Files

- `packages/canopycms/src/types.ts:` `BranchAccessControl`
- `packages/canopycms/src/authorization/branch.ts`
