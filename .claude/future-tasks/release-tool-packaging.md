# Make a bundled materialize release tool smaller and testable

**Status:** Open. **Priority: P3.** Filed 2026-10-07 from the adopting site's review of the
[materialize release hardening](materialize-release-hardening.md) epic. **Item 1 needs JP's approval**
(a new package entry point).

## State

A credentialed release job bundles `materializeAssets` from `canopycms/server`. That works, but:

1. **Size and reach.** The bundle carries the whole server graph, about 2.9 MB including octokit,
   simple-git and chokidar, none of which materialize needs, into the job holding release
   credentials. A narrow `canopycms/materialize` entry point would carry only the store, the
   transform engine and materialize.
2. **Exit codes.** A bundled tool re-derives the CLI's 0/1/2/3 contract from the report;
   `MATERIALIZE_EXIT_CODES` in `packages/canopycms/src/cli/asset-refs.ts` is `@internal`. An
   exported `exitCodeFor(report, { allowFailures })` would keep tools and the CLI in step.
3. **No test runs a bundle.** `server.materialize-exports.test.ts` checks that the exports exist.
   Nothing bundles the entry point to CommonJS and runs a transform. sharp loads only when a key
   is missing, so a "bundle loads" smoke test cannot catch a sharp the bundle cannot resolve.
4. **Statics vs transforms.** A report result carries no `kind`; only `STATIC_KEY_RE` in
   `materialize.ts` tells them apart.

## Proposal

Add a test that esbuilds the release-tool entry point to CommonJS (sharp and `@img/*` external),
runs it against a local store with one missing transform, and checks the report. Export
`exitCodeFor`. Add `kind` to `MaterializeResult` if a consumer needs it. Decide on the narrow entry
point with JP.
