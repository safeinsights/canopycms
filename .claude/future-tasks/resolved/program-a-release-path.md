# Program A — Release path

**RESOLVED 2026-07-30.** Prereleases are publishable on demand from any non-`main`
branch. See the implementation summary at the bottom.

**Part of:** [../production-readiness-program.md](../production-readiness-program.md)
**Size:** S · **Status:** done · **Blocked:** every workstream that needs an
adopter to consume unreleased Canopy work (E especially) — now unblocked

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

---

## Implementation summary (2026-07-30)

Shipped in [#171](https://github.com/safeinsights/canopycms/pull/171)
(canopycms) and [docs-site-proto#34](https://github.com/safeinsights/docs-site-proto/pull/34).

### How to publish a prerelease

GitHub → Actions → **Publish to npm** → *Run workflow* → pick a non-`main`
branch. Publishes all five packages as
`<main's version, patch-bumped>-int.<run_number>` under the `int` dist-tag.

### How to consume one

```bash
node scripts/canopy-deps.mjs int                  # resolve and pin the current int build
node scripts/canopy-deps.mjs int 0.0.61-int.74    # pin an exact build
```

### Design note: why `publish-prerelease.yml` is a reusable workflow

Not a style choice. npm allows **one trusted publisher per package, bound to a
workflow filename**, and all five packages are bound to `publish.yml` — there is
no `NPM_TOKEN`, publishing is pure OIDC. A standalone workflow could not have
authenticated. npm validates the **calling** workflow for `workflow_call`, so
routing through `publish.yml` is what makes this work with no npmjs.com changes
and no new secrets. **Any future publish channel must also enter through
`publish.yml`.**

Contrary to expectation, no merge to `main` was required: `workflow_dispatch`
needs the workflow *file* on the default branch, but reads the *trigger* from
the target ref. Details in [../program-log.md](../program-log.md).

### Files

- `.github/workflows/publish-prerelease.yml` — reusable workflow; hard-guards
  against `main`; `contents: read` makes "never writes a version back"
  structural rather than conventional
- `.github/workflows/publish.yml` — gains `workflow_dispatch` routing to the
  above; stable push-to-`main` path unchanged; concurrency scoped by event so a
  superseding dispatch cannot cancel a prerelease mid-way through five publishes
- `scripts/prerelease-version.mjs` — computes the version (new)
- `scripts/bump-version.mjs` — now accepts an explicit version to apply
- `docs-site-proto/scripts/canopy-deps.mjs` — `int` mode

### Verification (all executed against the live registry)

Published `0.0.61-int.74` from
[run 30586482757](https://github.com/safeinsights/canopycms/actions/runs/30586482757).

- `dist-tags` on all five packages: `latest: 0.0.60` unchanged, `int: 0.0.61-int.74`
- `npm install canopycms` → `0.0.60`; `@^0.0.60` → `0.0.60`; `@*` → `0.0.60`
- `npm install canopycms@int` → `0.0.61-int.74`
- `package.json` versions unchanged on `main`, `integration-202607-a`, and the
  feature branch after the run; no commit produced
- `canopycms-next@int` peer-depends on `canopycms: 0.0.61-int.74` (`workspace:*`
  resolves to the matching prerelease), so `@int` is a coherent set

### Gotcha worth remembering

Adopter pins need `--save-exact`. `npm install` re-applies its default `^`
prefix, and `^0.0.61-int.74` matches later prereleases of `0.0.61` *and* stable
`0.0.61` — a silent drift off the pinned build. Caught by end-to-end test, not
by inspection.

### Standing draft PR

[#172](https://github.com/safeinsights/canopycms/pull/172) —
`integration-202607-a` → `main`. Keep its body current as work lands: what
landed, what has been machine-reviewed, where a human should focus.
