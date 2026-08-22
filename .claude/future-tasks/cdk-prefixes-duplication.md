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
