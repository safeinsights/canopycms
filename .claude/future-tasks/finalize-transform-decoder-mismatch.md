# Upload finalize and the transform Lambda use different image decoders → "accepted but unrenderable" assets

Found during the deployment-test epic (2026-07-24) on the live deploy: a malformed
PNG was accepted at upload but every rendered view of it (MediaLibrary thumbnail,
`<img>`, preview) is a broken image.

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
