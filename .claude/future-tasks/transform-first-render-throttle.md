# A page's first render can throttle the transform Lambda

## Priority: P3 [BOTH]

Filed 2026-10-06, found while sizing the CMS Lambda's concurrency cap. **Not measured** on a
deployment; the mechanism is the one measured for the editor's chunks.

## The gap

`/assets/t/*` is an origin group: S3 first, the transform Lambda on a 403/404. A derivative is
made the first time it is requested, and `AssetSupport`'s transform Lambda is capped at 10
concurrent invocations (`TRANSFORM_LAMBDA_RESERVED_CONCURRENCY`, there to bound the anonymous
path's cost). A page whose first visitor needs more than 10 not-yet-made derivatives at once,
such as a freshly published image-heavy page, sends the excess to a saturated Lambda: each gets
a 429 and shows as a broken image. CloudFront does not cache a 429, and by the reload most
derivatives are in S3, so a reload fixes it. Images the host lazy-loads below the fold spread
the requests out, so it takes many images in view at once.

## Options

- Raise the default cap (the cost bound it exists for scales with it; see
  [transform-crop-signing.md](transform-crop-signing.md)).
- Materialize build-referenced derivatives at build time, option 3 in
  [transform-path-regional-resilience.md](transform-path-regional-resilience.md), which removes
  first-render transforms for published pages entirely.

Measure first: count derivatives requested by a real image-heavy page's first render.
