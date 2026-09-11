# [P3] Rename the `asset-staging` prefix to `asset-incoming`

Decided 2026-08-24 alongside the shared artifact-bucket design in the
infrastructure repo. Mechanical rename, no behaviour change.

## Why

"Staging" is an environment name in the SafeInsights org — there is a Staging
account and a staging host. A prefix called `asset-staging/` reads
as "assets belonging to the Staging environment" rather than "assets staged for
promotion," which is what it actually is.

`asset-incoming/` also matches the shared artifact plane, where CI uploads land
in `incoming/` and a promoter copies out of it. Both planes then use the same
word for the same shape: an untrusted writer lands bytes, a verifier promotes
them. The shared artifact bucket is named for the same reason.

## Why it is cheap now

Objects under this prefix expire after one day (the lifecycle rule in
`asset-support.ts`), so unlike most prefix renames there is **no data
migration** — a rename only has to tolerate 24 hours of overlap. Land the
rename, keep the old prefix accepted for a day, drop it.

This will not be cheap forever only in the sense that the reference count keeps
growing; the data is always ephemeral.

## Surface

`asset-prefixes.ts` is the source of truth (`staging: 'asset-staging'`), but the
string appears in roughly 20 files across both packages. Non-exhaustive:

- `packages/canopycms/src/assets/` — `asset-prefixes.ts`, `finalize.ts`,
  `keys.ts`, `store-parity.test.ts`, `finalize.test.ts`, `keys.test.ts`
- `packages/canopycms/src/api/` — `assets.ts`, `assets.test.ts`,
  `__test__/mock-client.ts`, `client.test.ts`
- `packages/canopycms/src/` — `server.ts`, `config/schemas/media.ts`
- `packages/canopycms-cdk/src/constructs/` — `asset-support.ts`,
  `cms-service.ts`, plus `asset-support.test.ts` and `cms-deploy.test.ts`
- Docs — `ARCHITECTURE.md`, `CODEBASE_GUIDE.md`

Worth grepping fresh rather than trusting this list.

## Watch out for

- `isValidStagingKey` in `finalize.ts` enforces that finalize can only promote
  from this prefix, and `finalize-security.test.ts` covers the attempt to point
  it at `asset-meta/` instead. Rename the function alongside the prefix, and make
  sure that test still exercises the real constraint afterwards — a rename that
  quietly weakens this check is worse than not renaming.
- The presigned POST policy references the prefix; a stale copy in a deployed
  environment would reject uploads until redeployed.
- The one-day lifecycle rule is prefix-matched. During the overlap window both
  prefixes need an expiry rule, or old-prefix objects linger forever.
