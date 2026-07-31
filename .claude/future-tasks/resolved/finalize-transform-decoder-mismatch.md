# Upload finalize and the transform Lambda use different image decoders → "accepted but unrenderable" assets

Found during the deployment-test epic (2026-07-24) on the live deploy: a malformed
PNG was accepted at upload but every rendered view of it (MediaLibrary thumbnail,
`<img>`, preview) is a broken image.

**RESOLVED (2026-07-30, fix/finalize-validates-decodability):** the write-up's
premise that "sharp is intentionally kept out of the CMS Lambda" was **wrong** —
`sharp` is a direct dependency of `packages/canopycms` and `Dockerfile.cms.template`
runs a plain `npm ci`, so sharp already ships in the CMS image; `transform.ts`
already statically imports it. That made direction 1 (validate through the real
decoder at finalize) cheap rather than a bundle-size tradeoff. Implemented:
`pipeline.ts`'s `rasterIsDecodable` forces a real sharp decode (decode-and-resize to
an 8x8 throwaway, not a `metadata()` header read) for `kind === 'raster'` only, gated
by the same `MAX_INPUT_PIXELS` cap `transform.ts` uses; fails OPEN (logs, lets the
upload through) only if sharp itself cannot be loaded, fails CLOSED (422, generic
user-facing message) if sharp loads and rejects the bytes. Direction 2 (round-trip via
the transform Lambda) was correctly ruled out as impossible in prod — the CMS Lambda
has no NAT/route to the transform Lambda's Function URL. Direction 3 (surface the
failure in the editor) was also done: `ImageField.tsx`'s preview now has an
`onError` fallback matching `AssetCard.tsx`'s "Preview unavailable" state, covering
both new decode rejections and pre-existing broken assets. See
`packages/canopycms/src/assets/pipeline.ts`, `pipeline.test.ts`,
`pipeline.sharp-unavailable.test.ts`, and `packages/canopycms/src/editor/fields/ImageField.tsx`.

## Root cause

The two halves of the asset pipeline validate images with different libraries:

- **Upload `finalize`** runs in the CMS Lambda, which deliberately does NOT bundle
  sharp. It sniffs magic bytes + reads dimensions with a lightweight header parser.
  A PNG with a valid IHDR but a corrupt IDAT (bad zlib/CRC) passes: it reads
  `16x16, kind: raster`, writes `asset-originals/<hash>.png` + `asset-meta/…`, and
  returns a normal asset record.
- **The transform Lambda** (serves `/assets/t/*`) runs real sharp/libvips. It rejects
  the same file with `Transform failed: vipspng: libpng read error` → HTTP 422.

Result: the asset "uploads successfully", then displays broken everywhere, with no
signal to the user that anything is wrong. (Static/SVG-passthrough assets under
`/assets/*` don't go through sharp, so only raster images that need transforming hit
this.)

## Why it matters

Real editors can upload images that are just-corrupt-enough (a truncated download, a
bad export, a wrong-extension file) and get a silently broken asset. The failure is
deferred from upload time (where it's actionable — "re-upload a valid image") to
render time (where it looks like a CMS bug).

## Possible directions (decide, don't assume)

1. **Validate through the real decoder at finalize.** Cleanest, but sharp is
   intentionally kept out of the CMS Lambda (bundle size / cold start). Could do a
   cheaper full-decode check with a lightweight pure-JS PNG/JPEG validator, or a
   deeper structural check than header-only sniffing.
2. **Round-trip via the transform Lambda at finalize** (invoke a tiny transform to
   confirm decodability before accepting) — couples finalize to the transform Lambda.
3. **Surface the transform 422 in the editor** so a broken thumbnail shows an explicit
   "this image could not be processed" state instead of the browser's broken-image
   glyph, and let the user delete/replace.

## Repro

deploy-test: upload a PNG with a valid header but corrupt body → finalize returns 200
and the asset appears in the MediaLibrary with a broken thumbnail; `curl` its
`/assets/t/f=webp,w=160/<hash>/<slug>.webp` → 422
`{"error":"Transform failed: vipspng: libpng read error"}`. Relates to
[[project-deployment-test-epic]] and [[asset-review-followups]].
