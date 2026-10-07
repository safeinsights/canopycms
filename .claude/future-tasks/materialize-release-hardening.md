# Materialize release hardening: create-only writes, release tooling, preview output prefix

**Status:** In progress on `int-materialize-release` (off `int-202610-b`). **Priority: P1.** Filed
2026-10-07 from the marketing site's request log, items 80 and 81, with the design confirmed by the
site's deploy session.

## Problems

1. **Overwrites (item 80).** `S3AssetStore.putPublicObject` sends a plain `PutObjectCommand`, so any
   principal allowed to materialize can replace a derivative production serves. Every public key is
   content-addressed, so no correct writer ever needs to overwrite one.
2. **Planting (found in triage).** Create-only writes do not stop a principal from writing wrong
   bytes at a derivative key production has not materialized yet; asset hashes are public in the
   HTML. Production's materialize then reports the key `existed` and serves it forever. So an
   untrusted materializer (a PR preview build) must never write under the prefix production serves.
3. **Release tooling needs the site (item 81).** `materializeAssets` has no public export; the CLI
   loads the whole `canopycms.config.ts` through jiti, so a credentialed release job needs a full
   install. A `mode: 'dev'` config with no usable `media` silently materializes into a local
   directory on the runner.

## Design

### PR A: create-only public writes

- `putPublicObject` and `putOriginal` send `IfNoneMatch: '*'` and return
  `'created' | 'already-exists'` (412 is `already-exists`), like `putMetaIfAbsent`. `LocalAssetStore`
  gets an exclusive create so store parity holds.
- S3 answers a conditional write that races another in flight with `409 ConditionalRequestConflict`.
  The S3 store's shared conditional-put helper retries it briefly, so a racing caller with no retry
  of its own (the lazy Lambda, finalize) ends in `created` or `already-exists`, never a throw.
- `storeTransform` returns its computed bytes either way (the raw route and lazy Lambda serve them),
  and reports which happened, so `materializeAssets` counts an `already-exists` as `existed`.
- `AssetSupport` adds a bucket-policy Deny on `s3:PutObject` to the content-addressed prefixes
  (`assets/*`, `asset-originals/*`, `asset-meta/*`) when `s3:if-none-match` is absent, on buckets it
  creates. Recovery from a bad object is delete, then re-materialize.
- Docs: that statement for adopter-owned buckets; replication is authorized as
  `s3:ReplicateObject`, not `PutObject`, so the Deny does not block it; the planting caveat.
- [materialize-adopts-lazy-tagged-objects.md](materialize-adopts-lazy-tagged-objects.md)'s fix
  changes from "rewrite untagged" (now impossible) to "remove the tag".

### PR B: release tooling

- Export from `canopycms/server`: `materializeAssets`, `collectAssetRefs`, `readAssetRefsFile`,
  `SharpUnavailableError` and their types. `materializeAssets` keeps taking a store instance;
  `createAssetStore` is already exported, so a bundled release tool needs no site config.
- The report gains `schemaVersion: 1`; each key keeps its status.
- CLI exit codes: 0 success; 1 usage or environment error; 2 content failures only (0 under
  `--allow-failures`); 3 any store failure.
- CLI `--bucket` and `--region` (both or neither) build an S3 store without loading the config.
  A store resolved from config that is not S3 is refused unless `--allow-local`.
- README: the exact IAM actions per mode.

### PR C: preview output prefix

- `materializeAssets({ outputPrefix })` reads meta and originals from the canonical prefixes and
  writes every key at `outputPrefix + key`. `outputPrefix` is relative, ends in `/`, has only
  `[A-Za-z0-9._-]` segments, and may not begin with any canopy prefix.
- Per key: already under the prefix → `existed`; in canonical `assets/` → server-side copy with
  `IfNoneMatch` and `TaggingDirective: REPLACE` (new store method `copyPublicObject`) → `copied`;
  otherwise transform from the original → `created`. A static (svg, pdf) is only ever copied.
- Production's materialize never reads the preview prefix, so it never trusts preview bytes.
- CLI `--output-prefix`. README: the preview role's grants, and that it can read every original.

## Amendments from the adversarial design review

- **The Deny is opt-in** (`AssetSupport` prop, default off). It binds the CMS Lambda, which runs the
  adopter's installed `canopycms`; upgrading `canopycms-cdk` first would deny every upload. README:
  upgrade `canopycms` first, then enable. It also denies `aws s3 cp` without `--if-none-match` and
  any multipart upload. Flipping the default is a follow-up task.
- **One 409 retry layer**, in the S3 store's conditional-put helper, matching
  `err.name === 'ConditionalRequestConflict'` with a budget of about 2 s. `isTransientStoreError`
  does not gain 409 (it also means `OperationAborted`, and `withRetry` would multiply attempts).
- **Local exclusive create:** temps go where `readOriginal`'s `{hash32}.` scan cannot see them; the
  headers sidecar is written before the blob is linked in; EEXIST is `already-exists`.
- **Tests:** a stub returning `undefined` must not read as `already-exists`; add the finalize crash
  path (original exists, meta absent).
- **Report v1** includes `copied` and `summary.copied` from PR B, so PR C does not change the schema.
- **Exit code 1** also covers an uncaught throw (bad refs file, config load failure).
- **PR C:** `CopySource` is URL-encoded per segment (keys contain `=`, `,`, `:`); per-key presence
  resolves to `dest | canonical | absent` from optional listings of both prefixes, falling back to
  HEADs, statics included; `outputPrefix` rejects `.` and `..` segments and compares canonical
  prefixes by segment.
- **PR C README:** the preview role needs `s3:ListBucket` (otherwise every miss is a 403 and a store
  failure); production hosts must route only `/assets/*` to the bucket, since `previews/*` holds
  attacker-writable bytes; scope each preview's writes to its own id or accept that one
  preview's build can write into another's; KMS needs on SSE-KMS buckets.
- **Unverified until a real-bucket check:** whether `TaggingDirective: REPLACE` with no tags needs
  `s3:PutObjectTagging`; whether `s3:if-none-match` is populated on CopyObject; and whether a
  `ListBucket` grant conditioned on `s3:prefix` makes a missing key's HEAD a 404 (a HEAD carries no
  `s3:prefix`). The adopting site runs that check before the epic merges.
- **Copy, not CloudFront failover:** an origin group falling back to the bucket root cannot work
  behind a viewer-request function that has already rewritten the URI to `/previews/{id}/…`.
- **Recovery under versioning:** a delete writes a delete marker, so the bad version stays
  restorable for the lock period, and the replica keeps serving it unless delete-marker replication
  is on.

## Constraints

- S3 accepts `If-None-Match` on CopyObject only since October 2025; raise the
  `@aws-sdk/client-s3` floor to a version whose `CopyObjectCommandInput` has `IfNoneMatch`.
- The adopting site keeps the default prefixes and its own bucket; it adds the Deny itself.
