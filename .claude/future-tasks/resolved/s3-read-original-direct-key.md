# `S3AssetStore.readOriginal` lists before every read

**Status:** RESOLVED 2026-10-07, branch `feat/s3-only-public-assets` (Phase 3 of
[image-materialization-epic.md](../image-materialization-epic.md)). Raised from P3 by review round 1:
list-first made every lazy-Lambda miss need `s3:ListBucket`, which a cross-account bucket policy
written for the old direct GET does not grant. `readOriginal(hash32, ext?)` now GETs
`asset-originals/{hash32}.{ext}` first and lists only on a miss; `storeTransform` passes `meta.ext`.
`LocalAssetStore` ignores the hint.

## State

`packages/canopycms/src/assets/store-s3.ts`'s `readOriginal(hash32)` runs `ListObjectsV2` on
`asset-originals/{hash32}.` and then GETs the key it found, because the original's extension is not
an argument. Every caller of `storeTransform` pays it: the raw route on a miss, `materialize-assets`
per missing key, and the lazy transform Lambda, which before it called `storeTransform` read
`asset-originals/{hash32}.{meta.ext}` directly and listed only when that missed.

## Proposal

Let `readOriginal` take the extension `storeTransform` already holds from the meta (`meta.ext`) and
try that key first, listing only on a miss. `LocalAssetStore` takes the same argument; the
store-parity test covers both. Measure on a materialize run of many missing keys before bothering:
the list is one small request against a transform that decodes a full image.
