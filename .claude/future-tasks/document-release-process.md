---
priority: P2
adopters: BOTH
summary: >-
  No doc anywhere describes how CanopyCMS is released, and there are now two channels (stable `latest` on push to main; `int` prereleases on manual dispatch) — confirmed absent from README, DEVELOPING, ARCHITECTURE and AGENTS. The trap worth writing down: npm allows one trusted publisher per package bound to a workflow filename, so any new publish workflow must route through `publish.yml` or fail auth opaquely
---
# Document the release process (two channels, one non-obvious constraint)

**Priority:** P2 · **Size:** S

Found while shipping the prerelease channel
([resolved/program-a-release-path.md](resolved/program-a-release-path.md), 2026-07-30).

## Problem

No top-level doc describes how CanopyCMS is released. `grep` for `publish.yml`,
`npm publish`, `dist-tag`, `release process`, or `bump-version` across
`README.md`, `DEVELOPING.md`, `ARCHITECTURE.md`, `AGENTS.md` returns nothing.

That was survivable with one channel and an automatic trigger. There are now two:

- **stable** — push to `main` auto-patch-bumps, publishes `latest`, commits the
  version back and tags
- **prerelease** — manual dispatch of *Publish to npm* against a non-`main`
  branch publishes `<main's version, patch-bumped>-int.<run_number>` under the
  `int` dist-tag, and never writes a version back

## Why it matters beyond convenience

One constraint will actively bite whoever touches publishing next, and it is
recorded only in workflow comments and the program log:

**npm allows exactly one trusted publisher per package, bound to a workflow
filename.** All five packages are bound to `publish.yml`, and there is no
`NPM_TOKEN` — publishing is pure OIDC. npm validates the *calling* workflow for
`workflow_call`, which is why `publish-prerelease.yml` is a reusable workflow
invoked by `publish.yml`. **Any third channel must also enter through
`publish.yml`, or the npm settings for all five packages must be changed
together.** Someone adding a standalone publish workflow will get an opaque auth
failure and no hint as to why.

Also worth stating: adopters consuming `int` builds must pin exactly
(`--save-exact`), because `^0.0.61-int.74` matches later prereleases of `0.0.61`
*and* stable `0.0.61`.

## Fix

A short release section in `DEVELOPING.md` (maintainer-facing: both channels, the
trusted-publisher constraint, the version scripts) and a note in `README.md` for
adopters on when they might be asked to use `@int` and how to pin it. The
material already exists in
[resolved/program-a-release-path.md](resolved/program-a-release-path.md) and
[program-log.md](program-log.md) — this is mostly relocation into docs an
adopter or a new maintainer would actually find.

## Partly done: the adopter half, 2026-10-01

An adopter running `0.0.67-int.90` could not find the documentation for the behaviour
they were running, and spent a verification pass on it. Two causes, both now fixed in
`packages/canopycms/README.md` — the only guide that ships inside the tarball:

- It hard-pinned its two repository links to `/blob/main/`, so an `int` reader landed on
  the last stable release's guides with nothing signalling the mismatch.
- Nothing said how to resolve an installed version back to its source ref. It turns out
  nothing needed building: the `--provenance` publish already records `ref` and
  `gitCommit` for every version on both channels, so the README now just shows the
  registry query that reads them back.

Still open here: the **maintainer-facing** half — a release section in `DEVELOPING.md`
covering both channels, the one-trusted-publisher-per-workflow-filename trap, and the
version scripts. Also still true that `int` consumers must pin exactly.

## Related

- [adopter-migration-unreleased-is-stale.md](resolved/adopter-migration-unreleased-is-stale.md) —
  the other half the same adopter hit, resolved 2026-10-01 in the same pass.
- Consider `npm deprecate`-ing superseded `int` versions to keep
  `npm view canopycms versions` readable; the prerelease list is the only real
  cost of the scheme.
