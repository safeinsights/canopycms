# Reserved branch names: `admin` / `assets` shadow /:branch routes

Flagged during the git-admin-observability epic's adversarial review (2026-07-24).

## Problem

The router's specificity comparator ranks static segments above `:branch`
params, so a branch literally named `admin` (or `assets`, the pre-existing
case) has its `/:branch/...` routes shadowed by the static `/admin/...`
(`/assets/...`) namespaces. Accepted precedent, but nothing stops a user from
creating such a branch and getting confusing 404/403s.

## Fix

Reject the reserved names in `parseBranchName` (or the branch-creation
validation path) with a clear error. Keep the list next to the route
registration so a future namespace addition updates both.

## Files

- `packages/canopycms/src/paths/branch.ts` (or wherever branch-name validation
  lives — verify)
- `packages/canopycms/src/http/router.ts` (source of the reserved list)
