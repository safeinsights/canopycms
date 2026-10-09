---
priority: P3
adopters: NEITHER
summary: >-
  CI's "Standalone CMS Image (npm, ubuntu-latest)" leg resolves dependencies fresh from the registry, so it fails whenever a dependency family is mid-publish. On 2026-10-09, during an AWS SDK release, it failed three times on PR #452 (ETARGET twice on different `@aws-sdk/*` versions, then a 404 on a tarball whose version was already listed) and passed on re-run once the publish settled. Candidate fix: `npm install --before=<about an hour ago>` in `scripts/smoke/standalone-image.mjs`, or one delayed retry on ETARGET/E404.
---
# The standalone-image npm leg fails while a dependency is mid-publish

## Problem

`scripts/smoke/standalone-image.mjs` (`packageManager('npm')`) scaffolds an adopter app from
`pnpm pack` tarballs and installs it with `npm install --no-audit --no-fund`. There is no
lockfile, so every transitive version is resolved from the registry at job time. A family that
publishes many packages in a row, like `@aws-sdk/*`, has a window in which one package's
metadata already asks for a sibling version that is not yet listed, or listed but not yet
downloadable.

On 2026-10-09 PR #452's run hit this three times in a row, each time on a different package:

1. `ETARGET` — no matching version for `@aws-sdk/credential-provider-env@^3.972.73`
2. `ETARGET` — no matching version for `@aws-sdk/credential-provider-http@^3.972.75`
3. `E404` on that package's `3.972.75` tarball, while `npm view` already listed the version

A re-run of the failed job passed once the tarball downloaded. The PR's code was not
involved. Both pnpm legs passed in the same run.

## Candidate fixes

- `npm install --before=<ISO time about an hour ago>`, which resolves only versions published
  before then and skips a release still in progress. The leg still tests a fresh resolve, as an
  adopter's first install would.
- One delayed retry when the install fails with `ETARGET` or `E404`. Simpler, but it hides
  the cause in the log.
