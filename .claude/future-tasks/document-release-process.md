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

## Related

- Consider `npm deprecate`-ing superseded `int` versions to keep
  `npm view canopycms versions` readable; the prerelease list is the only real
  cost of the scheme.
