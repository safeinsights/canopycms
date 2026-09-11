# [P3] `canopycms-cdk`'s `PREFIXES` is a duplicated literal with no parity test

Found by the human review of PR #257 (2026-08-22), rated low.

## The gap

`packages/canopycms-cdk/src/constructs/asset-support.ts` re-declares all five S3
prefixes as string literals. The infra-review epic's new
`expire-transform-outputs` lifecycle rule keys off that copy, as do four
`grantRead` calls. Meanwhile the transform Lambda **in the same package** imports
the canonical `ASSET_PREFIXES` from `canopycms/server`.

They agree today (both `assets/t`, and the rule's trailing slash correctly
excludes an `assets/thumbnail.png` sibling). If they ever diverge, the lifecycle
rule **silently matches nothing** — a deploy-time no-op with no error anywhere,
which is precisely the failure class the infra-review epic exists to eliminate.

## Why the stated reason for duplicating is now weaker

The duplication is documented, but its rationale — "no consumer has `canopycms`
resolvable from wherever its CDK code runs" — was undercut by PR #272, which made
`canopycms` a **declared peer dependency** of `canopycms-cdk` and added
`check:esm`'s declared-dependency check to enforce it.

**Corroborated 2026-09-08** by a claim-check pass over PRs #290-295, which
reached this independently and measured it. `canopycms-cdk` does not merely
*declare* the peer — its published main entry already imports it at runtime:

```
$ pnpm --filter canopycms-cdk run build
$ grep worker packages/canopycms-cdk/dist/index.js
export { CmsWorker } from './worker.js';
$ grep "^export" packages/canopycms-cdk/dist/worker.js
export { CmsWorker } from 'canopycms/worker/cms-worker';
```

That is tsc output carrying a bare, unresolved specifier (the esbuild bundle is
a different artifact, `worker/dist/index.js`, built for the EC2 instance), and
`canopycms` is a **non-optional** `peerDependency` in `package.json` — only
`aws-cdk-lib` and `constructs` are marked optional. So importing `canopycms-cdk`
at all already requires `canopycms` to resolve, and "importing it would break
the published construct" cannot be the reason for any duplication in this
package.

The same false rationale was carried, verbatim, by `cms-service.ts`'s
`isValidDeploymentName` comment and two comments in `cms-deploy.test.ts`; those
have been corrected to point here. **Phase 3 mechanical re-check (2026-09-08)
found the same false rationale in two more places the phase-2 pass missed** —
`deployment-name.ts`'s own `isValidDeploymentName` doc comment and
`deployment-name-fixtures.ts`'s file-level comment, both in the `canopycms`
package rather than `canopycms-cdk` — so the true count is five copies, not
three; those two have now also been corrected to point here. **Whoever takes
this task should decide the question once for BOTH duplications** — the S3
prefix constants this file is about, and the `isValidDeploymentName` /
`assertValidGitBranchName` rules — since they now rest on the same
(now-retracted) premise.

## Fix direction

Either import the canonical constants now that doing so is legitimate, or add a
two-line parity assertion to the CDK suite. The assertion is cheaper and does not
touch the synth path:

```ts
import { ASSET_PREFIXES } from 'canopycms/server'
expect(PREFIXES).toEqual(ASSET_PREFIXES)
```

Note the same test file already reaches across the package boundary for exactly
this kind of drift check (`deployment-name-fixtures`, and the media-block guard),
so the precedent and the import path both exist.
