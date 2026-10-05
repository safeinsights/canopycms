# `attachTo` leaves the CMS build's `/_next/static/*` to the site

## Priority: P3 [BOTH]

## The gap

`CanopyCmsService.attachTo` (`packages/canopycms-cdk/src/constructs/editor-routing.ts`) routes
`/edit`, `/edit/*` and `/api/canopycms/*` to the CMS Lambda on a distribution the site owns. The
editor page it serves loads the CMS build's chunks from `/_next/static/*`, and on that distribution
the path belongs to the site's static export. The two builds have different chunk sets and build
ids, so the site's `/_next/static/*` must serve both; the docs say so, but nothing provides it.

## Options

1. Give the CMS build a Next `assetPrefix` (say `/_canopy`) through `withCanopy` and have
   `attachTo` add `/_canopy/_next/static/*` with the long-cache policy `CanopyCmsDistribution` uses.
   Check first that a path-only `assetPrefix` is served by the standalone server at that path.
2. Document a pipeline step that copies the CMS build's `.next/static` into the site's
   `_next/static/`, and warn that a sync with `--delete` removes it.

Option 1 keeps the fix in the package. Measure how the adopter currently serves these files before
choosing.
