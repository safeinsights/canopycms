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
from one value, so the adopter states it once in a place the CDK app can also import. Check first
that the standalone server serves `/<prefix>/_next/static/*` at that path for every supported Next
version. One adopter runs exactly this shape today, which suggests it does.
