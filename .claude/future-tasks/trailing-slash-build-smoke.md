---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-04, from the PR #366 review. Nothing in CI builds with `trailingSlash: true`, so a Next upgrade that stops inlining `withCanopy`'s `env` into canopycms code, or changes the redirect regexes, would silently bring back a 308 on every editor API call. Add one assertion-backed build or e2e variant
---
# CI smoke for a `trailingSlash: true` build

## Priority: P3 [BOTH]

Filed 2026-10-04 from the round-1 review of PR #366 (editor-API trailing slash).

## The gap

The API client avoids Next's `trailingSlash` 308s only because of two things no CI job runs:

- Next substitutes `process.env.CANOPY_TRAILING_SLASH` (set by `withCanopy` through `env`)
  inside canopycms's own transpiled code. The unit tests stub `process.env` directly.
- The catch-all route answers `/api/canopycms/<path>/` without a redirect.

`apps/example1` doesn't set `trailingSlash`, so the one proof is a manual build, quoted in
PR #366. A Next upgrade that narrows `getNextConfigEnv` (`next/dist/build/define-env.js`) or
changes the redirect regexes (`next/dist/lib/load-custom-routes.js`) would quietly bring the
double invocations back.

## Proposed solution

Pick the cheaper of the two:

- In the path-gated `example1-build` job, run one extra build with `trailingSlash: true` and
  assert that the editor's client chunk holds the substituted literal (`try{return!0}`) and no
  `CANOPY_TRAILING_SLASH` name. The same flag shapes the editor's preview URLs.
- Add a `trailingSlash: true` variant to an e2e shard, and assert that an editor load makes no
  308s to `/api/canopycms/*`.

## Related

- [trailing-slash-router-helpers.md](trailing-slash-router-helpers.md)
- [preview-src-trailing-slash.md](resolved/preview-src-trailing-slash.md)
