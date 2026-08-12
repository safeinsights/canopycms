# Reserved branch names: `admin` / `assets` shadow /:branch routes

## RESOLVED — 2026-08-12 (`fix/adopter-config-correctness`)

`createBranchHandler` rejects the 7 names that collide with a static top-level
route namespace: `admin`, `assets`, `branches`, `groups`, `permissions`,
`users`, `whoami` (enumerated from the live route table, not guessed).

Two deviations from the fix sketch below, both deliberate:

- **Creation path, not `parseBranchName`.** Enforcing in `branchNameSchema`
  would apply to every `:branch` param, which means a branch named `admin` that
  already exists would 400 on its own DELETE route — un-removable through the
  API. Guarding creation prevents new ones while leaving existing ones
  addressable. This also matches the scope note on the adjacent
  `RESERVED_SETTINGS_BRANCH_PREFIX` guard.
- **The list is a constant, pinned by a test, rather than derived at runtime.**
  It cannot be computed from the router: `api/validators.ts` is imported *by*
  the route modules, so importing the router from the validation side is a
  cycle. `RESERVED_ROUTE_BRANCH_NAMES` therefore lives in dependency-free
  `paths/branch-name.ts` (next to `RESERVED_SETTINGS_BRANCH_PREFIX`), and
  `http/router.test.ts` derives the set from `createCanopyRouter().routes` and
  asserts equality — so a new top-level namespace fails that test until the
  constant is updated.

Matching is exact and case-sensitive, mirroring how the router compares path
segments: `Admin` and `admin-docs` are not shadowed and stay creatable.

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
