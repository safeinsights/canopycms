---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-07, branch `feat/s3-only-public-assets`. An identity (`orig`) transform is exempt from the 10 MiB output cap (one per asset, bounded by the upload and pixel caps; measured: any noisy PNG over ~10 MiB re-encoded past it), so a serialized `orig` no longer blocks a release. The one-copy-per-serialized-image storage cost is accepted
---
# Serialized image values make the materializer store every full-size `orig`

**Status:** RESOLVED 2026-10-07, branch `feat/s3-only-public-assets` (Phase 3 of
[image-materialization-epic.md](image-materialization-epic.md)). The first option: an identity
transform is exempt from `MAX_OUTPUT_BYTES` (`assets/transform.ts`), so a serialized `orig` is never
a release-blocking 413. Measured with sharp 0.35.3, an `orig` re-encode is 1.0x a default-encoded
PNG, about 2x a level-9 one, and up to 4x a smooth photo saved at maximum compression; any noisy PNG
over about 10 MiB exceeded the cap. Its size is bounded by the decoded pixels (about 3-4 bytes per
pixel at `MAX_INPUT_PIXELS`), and an asset has one. The storage cost stays and is accepted: one
derivative per serialized image, which the collector cannot tell apart from a rendered one.

## State

An image value handed to a client component (`<PostPreview initialData={data} />`, the README's
pattern) is serialized into the RSC payload, so its stored `src`,
`/assets/t/orig/{hash32}/{slug}.{ext}`, appears in the build output. `collect-asset-refs` records
it, and `materialize-assets` stores an EXIF-stripped full-size copy of every such image even when
no page requests `orig`. Two costs:

- Storage: one extra derivative per image, kept forever.
- A release blocker: `applyTransform` rejects an output over `MAX_OUTPUT_BYTES` (10 MiB) with 413.
  A large photographic PNG under the 16.7 MP input cap can re-encode past that, so its `orig` is a
  content failure that only `--allow-failures` gets past, for a URL no browser asks for.

The collector cannot tell a rendered `orig` from a serialized one: a static export inlines the RSC
payload into each page's HTML.

## Options

- Let an identity (`orig`) transform exceed `MAX_OUTPUT_BYTES`, since its size is bounded by the
  original's upload cap. Decide alongside Phase 3's `MAX_INPUT_PIXELS` change.
- Have the collector skip `orig` keys found only inside `self.__next_f.push(...)` script payloads.
  Fragile: it couples the collector to Next's flight encoding.
