# `BranchAccessControl.adminOnly` is defined but never enforced

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
