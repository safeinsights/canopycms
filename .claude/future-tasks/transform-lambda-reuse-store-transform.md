# The transform Lambda repeats `storeTransform`'s checks instead of calling it

**Status:** Open. **Priority: P3.** Filed 2026-10-06 from Phase 2 of
[image-materialization-epic.md](image-materialization-epic.md).

## State

`packages/canopycms/src/assets/materialize.ts`'s `storeTransform` is the one place the raw route and
`materialize-assets` compute and store a transform: meta lookup, raster-only, slug pinned to
`meta.slug`, ext matching the source format without `f=`, original read, `applyTransform`, PUT with
`TRANSFORM_CACHE_CONTROL`. `packages/canopycms-cdk/lambda/asset-transform/handler.ts` keeps its own
copy of every one of those steps over raw `S3Client` calls, plus its own copy of the Cache-Control
string. Comments in both say they must agree; nothing checks it.

## Proposal

When Phase 3 reshapes the lazy path, have the Lambda build an `S3AssetStore` for its bucket and call
`storeTransform` (exported through `canopycms/server`), keeping only the Lambda-specific 301 and
inline-size handling. Check the Lambda bundle size before and after: `S3AssetStore` also pulls the
presigned-post and request-presigner packages.
