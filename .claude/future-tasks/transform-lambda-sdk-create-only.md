# The lazy transform Lambda's create-only writes depend on the Lambda runtime's AWS SDK

**Status:** Open. **Priority: P2.** Filed 2026-10-07 from the adopting site's review of the
[materialize release hardening](resolved/materialize-release-hardening.md) epic.

## State

`packages/canopycms-cdk/lambda/asset-transform/build.mjs` bundles `handler.ts`, and with it the
`canopycms` that `canopycms-cdk` was built with, but leaves `@aws-sdk/*` external so the Lambda's
managed runtime supplies it. The store's create-only writes send `IfNoneMatch: '*'`. An SDK that
predates conditional writes drops that field without an error, and with `AssetSupport`'s
`enforceCreateOnlyWrites` Deny in place every lazy write is then denied (the handler answers 500).
The `canopycms` package floor (`@aws-sdk/client-s3` `^3.1092.0`) does not reach this bundle.

## Proposal

Bundle `@aws-sdk/client-s3` into the handler, or assert at cold start that the runtime SDK's
version supports `IfNoneMatch`. Measure the bundle size change first. Either way, add a test that
fails if the bundled handler would send a `PutObject` without `IfNoneMatch`.
