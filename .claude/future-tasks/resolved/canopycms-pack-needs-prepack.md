# `canopycms` (and siblings) need a `prepack` build guard like `canopycms-cdk` got

**RESOLVED 2026-07-24** (PR #143): `"prepack": "pnpm run build"`
added to `canopycms`, `canopycms-next`, `canopycms-auth-clerk`, `canopycms-auth-dev`.
Verified the stale-dist repro turns green: with `dist/` deleted, both `pnpm pack` and
`npm pack` now build first and the tarball contains fresh `dist/` (including
`git-manager.js`). CI publish workflow unchanged — its explicit build step now
double-builds harmlessly, same as cdk has since PR #128.

Found during the deployment-test epic (2026-07-24).

## Problem

`canopycms`'s `dist/` is only refreshed by an explicit `pnpm run build`. Running
`pnpm pack` (or `npm pack`) without building first silently packs a **stale `dist/`**
— during the epic this shipped an old `git-manager.js` into the vendored tarball, and
the deployed image ran outdated code until the pack was redone after a build. The CI
publish workflow builds first so published releases are fine, but any local pack / any
future publish-step reordering is a footgun.

`canopycms-cdk` already got the fix in this epic (PR #128): a `prepack` script that
builds all required artifacts, so any pack — local or CI — ships runnable output.

## Fix

Add a `prepack` script to the packages that have a build step and are consumed as
tarballs: at minimum `canopycms` (`"prepack": "pnpm run build"`), and check
`canopycms-next`, `canopycms-auth-clerk`, `canopycms-auth-dev`. Verify `prepack`
composes correctly with the CI publish workflow (which already calls `build` — a
redundant build is harmless, a missing one is a shipped-stale-dist bug). Confirm
`prepack` runs under both `pnpm pack` and `npm pack`.

## Evidence

Re-vendoring `canopycms-0.0.58.tgz` after only `pnpm pack` produced a tarball whose
`dist/git-manager.js` lacked the just-committed `GIT_ENV_PASSTHROUGH` change;
`grep GIT_ENV_PASSTHROUGH node_modules/canopycms/dist/git-manager.js` returned 0 until
a `pnpm run build && pnpm pack` was done. Relates to [[project-deployment-test-epic]].
