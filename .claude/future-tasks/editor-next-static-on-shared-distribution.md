---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-05. A CMS build sharing a distribution with a static site sets Next's `assetPrefix` and passes the same value to `CanopyCmsService.attachTo`'s `editorAssetPrefix`; nothing ties the two, and drift 404s the editor's chunks. Follow-up: let `withCanopy` set `assetPrefix` for the CMS build from one value. Also: `next/image` in preview views requests the site's `/_next/image`
---
# The CMS build's `assetPrefix` and `editorAssetPrefix` are set in two places

## Priority: P3 [BOTH]

## The gap

A CMS build that shares a CloudFront distribution with a static site must move its chunks out of
`/_next/static/*`, which the site serves: the adopter sets Next's `assetPrefix` (e.g.
`'/edit-assets'`) in the CMS build's `next.config`, and passes the same value to
`CanopyCmsService.attachTo`'s `editorAssetPrefix`
(`packages/canopycms-cdk/src/constructs/editor-routing.ts`), which routes `/<prefix>/*` to the
Lambda. Nothing ties the two values together. If they drift, the editor's chunks 404 after a
deploy that synthesizes cleanly.

## Suggested shape

Let `withCanopy` (`packages/canopycms-next/src/with-canopy.ts`) set `assetPrefix` for the CMS build
from one value, so the adopter states it once in a place the CDK app can also import. The
standalone server does serve `/<prefix>/_next/static/*` at that path on Next 15.5.21 (a built
app answered 200 for `/edit-assets/_next/static/chunks/main-*.js`); check the other supported
Next versions.

## Also: `next/image` in preview views

With `attachTo`'s `previewPrefix`, the preview route renders the site's views from the CMS build. A
view that uses `next/image` requests `/_next/image?url=…`, which on a shared distribution is the
site's `/_next/*` and 404s; `assetPrefix` does not move it. Reasoned from how Next builds the image
URL, not reproduced. Either require `images.unoptimized` for the CMS build (`withCanopy` could set it
alongside `assetPrefix`) or have `attachTo` route `/_next/image` too.
