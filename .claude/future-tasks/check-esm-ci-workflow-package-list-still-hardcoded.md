# CI's build/publish steps still hardcode the 5-package list, separately from PACKAGES

Found 2026-08-22 by an independent review of `scripts/check-esm-imports.mjs`, while fixing
`canopycms-cdk`'s undeclared `canopycms` peer dependency
(`fix/packaging-guard-blind-spots`).

## What's fixed, and what isn't

`check-esm-imports.mjs`'s `PACKAGES` list now has a matching guard: `checkCoverage()` calls a
new `checkPackageListIsComplete()` that fails loudly if any non-private `packages/*/package.json`
is missing from `PACKAGES`. A sixth published package can no longer be silently invisible to
this guard.

What that does **not** cover: `.github/workflows/ci.yml`'s "Build other published packages"
step (~line 73) and `publish.yml`/`publish-prerelease.yml`'s build/publish steps all hardcode
the same 5 package names, independently of `PACKAGES` and of each other. Adding a sixth package
and remembering to add it to `PACKAGES` (now enforced) is not enough on its own:

- If the new package is forgotten from CI's "Build other published packages" step, its `dist/`
  is never built, and `pnpm check:esm` fails with "dist/ does not exist — run `pnpm build`
  first" — a real CI failure, just a less specific one than naming the missing workflow step
  directly. Not a silent gap, but a confusing one.
- If it is forgotten from `publish.yml`/`publish-prerelease.yml`, the package would never
  actually get published to npm even though every other guard in the repo is green — CI passes,
  but the release is silently incomplete. Nothing today would catch this.

## Why not fixed here

The obvious full fix — point CI at the root `pnpm build`/`pnpm -r run build`, which is already
dynamic over the whole workspace — was considered and rejected for this PR: `ci.yml`'s existing
comment states apps/example1 and apps/test-app are deliberately excluded from this job's build
step ("those get their own dedicated build coverage in the dual-build and e2e jobs below"), so
switching to the recursive root command would silently change that job's scope and timing
contract. That's a real design decision from a different PR, not something to overwrite as a
side effect of a packaging-guard fix.

## Suggested direction

Either:

1. Generate the workflow's package list from the same source of truth `check-esm-imports.mjs`
   now enforces (e.g. a small script step that reads non-private `packages/*/package.json`
   names and feeds them into a `pnpm --filter` invocation, or a matrix job), or
2. At minimum, add a comment at each hardcoded list site (`ci.yml`'s build step,
   `publish.yml`, `publish-prerelease.yml`) pointing back to `PACKAGES` in
   `check-esm-imports.mjs`, so a future editor updating one remembers to check the others — this
   was tried in isolated pockets before (e.g. `cli/project-detect.ts`'s `CDK_DEPENDENCIES`
   comment) but never for this specific 4-way duplication.

Publish-side silent incompleteness (bullet 2 above) is the more dangerous half of this and
would benefit from its own guard — e.g. a post-publish step that diffs the packages actually
published in this run against non-private `packages/*/package.json`.
