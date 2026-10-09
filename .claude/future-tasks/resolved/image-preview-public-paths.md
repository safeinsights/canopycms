# The `image` field's preview fails for any `public/` path

> **RESOLVED 2026-10-08**, branch `fix/image-preview-public-paths`, base `int-202610-b`. Adopter
> request #89.

## Problem

An adopter converted image fields to `type: 'image'` keeping their existing `public/` paths (the
serving-neutral first step `docs/adopter-migration.md` recommends). Every `ImageField` then showed
"Preview unavailable": the field built its preview with `assetUrl(..., { baseUrl: <raw route> })`,
and `assetUrl` puts every root-relative src behind its mount, so `/people/x.png` was fetched as
`/api/canopycms/assets/raw/people/x.png` and 404'd. The public site rendered the same values fine,
because without a mount `assetUrl` returns a non-asset src unchanged. Around 28 of the adopter's
images stay on `public/` paths for the foreseeable future.

Markdown/MDX body previews were unaffected: `imagePreviewHandler` already used `editorImageSrc`,
which passed non-`/assets/` srcs through — but raw, so a backslash spelling such as `/\evil.com/x`
reached an editor `<img>` unneutralized.

## Fix

- `assets/asset-url.ts` exports `isAssetStoreSrc`, the one "is this in the `/assets` space"
  predicate.
- `editor/media/editor-image-src.ts`'s `editorImageSrc(src, baseUrl, opts?)` is the single editor
  resolver: asset-store srcs go through `assetUrl` behind the raw route with width/crop applied;
  every other src goes through `assetUrl` with no mount, which returns absolute, protocol-relative,
  `data:` and `blob:` srcs as written and neutralizes spellings a browser would read as off-origin.
- `ImageField` (preview and crop source), `AssetCard` thumbnails and the MDX `imagePreviewHandler`
  all use it.
- `ImageField` hides Crop for a src outside the asset store: `assetUrl` never applies a crop there,
  so a stored crop would silently do nothing.

## Tests

`editor-image-src.test.ts` (width/crop on a transform src; `public/` raster and svg as written;
protocol-relative and `blob:` as written; backslash, mixed-slash and tab-split spellings stay
same-origin) and `ImageField.test.tsx` (`/logos/x.svg` and `/people/x.png` preview at their own
path with no Crop button). Each was red before the fix, and four deliberate breaks of the fix each
failed the tests aimed at them.
