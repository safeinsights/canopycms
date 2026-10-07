# The transform Lambda repeats `storeTransform`'s checks instead of calling it

**Status:** RESOLVED 2026-10-07, branch `feat/s3-only-public-assets` (Phase 3 of
[image-materialization-epic.md](../image-materialization-epic.md)). The Lambda builds an
`S3AssetStore` with `createAssetStore` and calls `storeTransform`, both exported from
`canopycms/server` with `TRANSFORM_CACHE_CONTROL`; it keeps only the canonical 301, the generic 404
body, the inline 200 and the over-4 MiB `no-store` 302. Bundle (`build.mjs --skip-native`):
1,112,906 B at the branch head, about 17 KB more than the base (the presigner packages were already
external and required). `readOriginal` takes the meta's ext and reads that key first
([s3-read-original-direct-key.md](s3-read-original-direct-key.md)), so the Lambda still needs no
`s3:ListBucket` to transform an asset that exists.

## State

`packages/canopycms/src/assets/materialize.ts`'s `storeTransform` is the one place the raw route and
`materialize-assets` compute and store a transform: meta lookup, raster-only, slug pinned to
`meta.slug`, ext matching the source format without `f=`, original read, `applyTransform`, PUT with
`TRANSFORM_CACHE_CONTROL`. `packages/canopycms-cdk/lambda/asset-transform/handler.ts` keeps its own
copy of every one of those steps over raw `S3Client` calls, plus its own copy of the Cache-Control
string. Comments in both say they must agree; nothing checks it.

## Proposal

When Phase 3 reshapes the lazy path, have the Lambda build an `S3AssetStore` for its bucket and call
`storeTransform` (after exporting it through `canopycms/server`), keeping only the Lambda-specific 301 and
inline-size handling. Check the Lambda bundle size before and after: `S3AssetStore` also pulls the
presigned-post and request-presigner packages.
