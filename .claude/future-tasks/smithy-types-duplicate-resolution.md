# Two copies of `@smithy/types` make `aws-sdk-client-mock` untypeable for some AWS clients

**Status: open.** Found 2026-09-12 while writing
`packages/canopycms-cdk/worker/secrets.test.ts` (PR A1 of adopter requests #45/#46).

## Problem

`packages/canopycms-cdk` installs two AWS SDK clients and one mocking library, and they do
not agree on `@smithy/types`:

| Package | version | resolves `@smithy/types` |
| --- | --- | --- |
| `@aws-sdk/client-s3` | 3.1092.0 | 4.16.1 |
| `aws-sdk-client-mock` | 4.1.0 | 4.16.1 |
| `@aws-sdk/client-secrets-manager` | 3.1018.0 | **4.13.1** |

All three declare compatible ranges; pnpm simply resolved the two SDK clients at different
times and kept both copies. The types are structural, and two copies of them are not mutually
assignable.

The consequence is invisible until someone mocks the odd client out.
`mockClient(SecretsManagerClient)` does not match `InstanceOrClassType<Client<…>>`, so the
overload degrades to `Client<MetadataBearer>` and **every** `.resolves({ SecretString: … })`
fails `tsc --noEmit -p worker/tsconfig.json` with TS2353 "Object literal may only specify
known properties". Ten errors from five call sites, none of which names the real cause.

`lambda/asset-transform/handler.test.ts` uses the identical idiom against `S3Client` and
typechecks cleanly — not because that usage is different, but because its client happens to
share 4.16.1 with the mock. That is the lockfile's luck, and it makes the failure look like
a mistake in whichever test file hits it next.

## Why it matters

Small, but it taxes exactly the work we keep doing: the next person to unit-test an AWS call
in `canopycms-cdk` hits ten opaque type errors and has to either diagnose a transitive
resolution skew or give up on the house idiom. `worker/secrets.test.ts` did the latter — it
mocks the module boundary with `vi.mock` + `importOriginal` instead, which is a good test but
is now the only one of its shape in the repo.

## Why it was not fixed in passing

Both fixes reach further than a PR about secret handling should:

- **`pnpm.overrides` for `@smithy/types`** — measured at 129 insertions / 151 deletions in
  `pnpm-lock.yaml`, and it changes resolution for `canopycms`'s S3 asset store too. A pinned
  version also rots: the next SDK bump is silently held to an old `@smithy/types`.
- **`pnpm update @aws-sdk/client-secrets-manager`** — measured, and it does **not** work:
  it goes to 3.1131.0, which pulls `@smithy/types@4.18.0` and simply moves the mismatch
  (mock still on 4.16.1), for 897 lines of lockfile churn.

## Shape of the fix

Probably `pnpm dedupe`, which re-resolves to the fewest packages without a permanent pin —
unmeasured, and it should be done as its own change with the full test suite behind it, not
folded into a feature PR. Verify with
`tsc --noEmit -p packages/canopycms-cdk/worker/tsconfig.json` after converting
`worker/secrets.test.ts` back to `mockClient(SecretsManagerClient)`; that file's header
comment documents the skew and should be trimmed to a pointer when this is resolved.

If the duplicate turns out to be unavoidable, the alternative is to accept `vi.mock` +
`importOriginal` as a second sanctioned idiom and say so in `DEVELOPING.md`, so the next
person does not rediscover this.
