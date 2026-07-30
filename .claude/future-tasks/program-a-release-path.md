# Program A — Release path

**Part of:** [production-readiness-program.md](production-readiness-program.md)
**Size:** S · **Status:** not started · **Blocks:** every workstream that needs an
adopter to consume unreleased Canopy work (E especially)

## Problem

`.github/workflows/publish.yml` fires only on push to `main` and auto-patch-bumps.
`integration-202607-a` is 55 commits ahead of `main` and those commits exist in no
published version, so an adopter installing from npm gets 0.0.60 and cannot see
any of it. Human review of the integration branch is the scarce resource, so
gating adopter access on that review blocks all downstream work.

## What to build

### 1. `.github/workflows/publish-prerelease.yml`

- **Trigger:** `workflow_dispatch` (branch chosen in the Actions UI); optionally
  also `push` on `integration-*`.
- **Hard guard:** fail immediately if the ref is `main`. This workflow must never
  be able to touch the stable channel.
- **Version:** compute at publish time as `<main's version, patch-bumped>-int.<github.run_number>`.
  **Do not commit the version back to the branch** — `publish.yml`'s
  bump-and-commit must remain the only writer of `package.json` versions, or the
  two workflows will fight over the version field.
- **Publish:** `npm publish --tag int` for all five packages (`canopycms`,
  `canopycms-next`, `canopycms-auth-clerk`, `canopycms-auth-dev`,
  `canopycms-cdk`). Reuse `publish.yml`'s trusted-publisher/OIDC setup, the npm@11
  bootstrap, and the `generate:client` step.
- Keep the existing `prepack` build guards in play so a prerelease can never ship
  stale `dist/` (see [resolved/canopycms-pack-needs-prepack.md](resolved/canopycms-pack-needs-prepack.md)).

### 2. Standing draft PR `integration-202607-a` → `main`

Open it and keep the body current: what has landed, what has been machine-reviewed,
and where a human reviewer should focus. This is the single artifact for human
review; it is drained when review time exists rather than per change.

### 3. `int` mode in `docs-site-proto/scripts/canopy-deps.mjs`

The script already toggles the five canopy deps between `file:../canopycms/...`
and npm versions. Add a third mode that pins an exact prerelease version, so
switching an adopter onto unreleased work is one command.

## Why prereleases are safe for adopters

Two independent mechanisms, both verified:

1. `npm install <pkg>` resolves the `latest` dist-tag. `--tag int` never moves
   `latest`; only `publish.yml` on `main` does.
2. npm semver excludes prerelease versions from range matching unless the range
   itself names a prerelease at the same major.minor.patch. `^0.0.60`, `0.0.x`,
   and `*` will never resolve `0.0.61-int.3`.

The only cost is cosmetic: prerelease versions stay visible in
`npm view <pkg> versions`. Mitigate by publishing on demand rather than per push,
using one monotonic counter, and `npm deprecate`-ing superseded prereleases.

## Verification

- Publish a prerelease from the integration branch.
- `npm view canopycms dist-tags` still shows `latest: 0.0.60` (or whatever `main`
  last published) and a separate `int` tag.
- In a scratch directory, `npm install canopycms` resolves the `latest` version,
  **not** the prerelease.
- `npm install canopycms@int` resolves the prerelease.
- Confirm the integration branch's `package.json` version fields are unchanged
  after the run.

## Definition of done

Prereleases publishable on demand from any integration branch, provably invisible
to normal installs; the standing draft PR open with a current body; adopters
switchable with one command.
