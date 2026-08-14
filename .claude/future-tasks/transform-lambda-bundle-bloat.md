# Transform Lambda bundle pulls in unrelated canopycms code via canopycms/server

> **Re-scoped 2026-08-14 — the "blocked on approving a new package entrypoint"
> framing was answering the wrong question.** The consumer here is
> `packages/canopycms-cdk/lambda/asset-transform/handler.ts`, which is
> **first-party code in this monorepo**, not an adopter. So no *public* entrypoint
> is needed: what is needed is for the Lambda bundle to stop pulling in the
> `canopycms/server` barrel. Solve it at the build layer — an esbuild alias, a
> private `#internal` subpath via the `imports` field, or pointing the Lambda
> build at the source module directly — and the `exports` map stays untouched.
>
> That matters because the no-new-entrypoints rule exists to stop public API
> surface sprawl: every entrypoint is a contract maintained forever, and this
> one would exist solely to serve a caller we control. **JP's call, 2026-08-14:
> do not grant the entrypoint.** Stays P3 — the bloat is non-functional (well
> under Lambda's 250MB limit, negligible cold-start), so this is hygiene to do
> when someone is already in the transform Lambda's build, not on its own.

## Problem

`packages/canopycms-cdk/lambda/asset-transform/handler.ts` (the prod on-demand image
transform Lambda, PR 7 of the assets/media epic) imports `parseTransformPath`,
`formatDirectives`, `applyTransform`, `ASSET_PREFIXES`, and the `AssetMeta` type from
`canopycms/server` — per the PR 7 task spec's explicit instruction to prefer reusing the
package's existing server entry over adding a new one.

`canopycms/server` is a broad barrel (`export * from './content-reader'`, `'./services'`,
`'./content-store'`, `'./schema'`, `'./branch-workspace'`, etc.). esbuild bundles the
handler with `sharp`/`@img/*`/`@aws-sdk/*` external (see `build.mjs`), and the resulting
`handler.js` is ~1 MB — measured to contain dead code from `octokit`, `simple-git`, and
`proper-lockfile` (none of which the transform Lambda ever calls; those are pulled in
transitively through `server.ts`'s re-export of git/branch-workspace/content-store
modules). Tree-shaking didn't eliminate them, likely because those modules have
top-level side effects or CJS interop boundaries esbuild can't prove are safe to drop.

In absolute terms this is NOT currently a blocker: total Lambda asset size is ~30 MB
(dominated by sharp + libvips' native binary, ~18 MB), well under Lambda's 250 MB
unzipped limit, and the extra ~1 MB of dead JS has negligible cold-start impact. It is,
however, avoidable dead weight and unrelated attack surface (a Lambda whose only job is
image resizing shouldn't contain a GitHub API client and git-lockfile-parsing code), and
is worth a security-review eyebrow-raise if left as-is.

## Proposed Fix

Give the transform Lambda (and any future non-Next.js consumer that only needs the
asset/transform primitives) a narrow, dedicated `canopycms` package export — e.g.
`"./assets/transform"` — re-exporting only `parseTransformPath`, `formatDirectives`,
`applyTransform`, `ASSET_PREFIXES`, and `AssetMeta`. This is a NEW package entrypoint
(`packages/canopycms/package.json`'s `exports` map), which per this repo's working
agreements needs explicit approval before adding — hence deferring it here rather than
doing it inline during PR 7.

Once approved, switch `handler.ts`'s import from `canopycms/server` to the new narrow
entry and re-measure `handler.js`'s bundle size / confirm the octokit/simple-git/
proper-lockfile strings are gone (`grep -c "simple-git\|octokit\|proper-lockfile"
lambda/asset-transform/dist/handler.js` should be 0).

The `canopycms/server` re-exports added for this (in `packages/canopycms/src/server.ts`)
should stay either way — they're useful to any other server-side consumer of the
transform engine, narrow entry or not.

## Files

- `packages/canopycms-cdk/lambda/asset-transform/handler.ts`
- `packages/canopycms-cdk/lambda/asset-transform/build.mjs`
- `packages/canopycms/src/server.ts` (the re-exports added for this)
- `packages/canopycms/package.json` (where the new narrow entry would go, if approved)
