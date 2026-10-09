---
priority: P3
adopters: NEITHER
summary: >-
  RESOLVED: `scripts/smoke/standalone-image.mjs` retries the scaffold's install and the image's `docker build` after 30, 60 and 120 s when their output shows npm's ETARGET/E404/ENOTFOUND or pnpm's NO_MATCHING_VERSION/FETCH_404, logging the matched code; any other failure fails at once. The leg still resolves unpinned. Originally: CI's "Standalone CMS Image (npm, ubuntu-latest)" leg failed three times on PR #452 during an AWS SDK release (ETARGET twice, then a 404 on a listed tarball).
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
