# Alarm on a 4xx rate for `/assets/t/*`

**Status:** Open. **Priority: P3.** Filed 2026-10-07 as a follow-up of
[image-materialization-epic.md](resolved/image-materialization-epic.md).

## State

In `AssetSupport`'s default mode the public `/assets/t/*` path is S3-only: a derivative the release
did not materialize is a 403 and renders as a broken image. `collect-asset-refs` can only find URLs
that appear as text in the build output, so a URL site code builds at runtime in the browser (a
width chosen on interaction, say) is never materialized, and nothing reports it.

## Proposal

A per-distribution CloudFront alarm on the 4xx rate of the `/assets/t/*` behaviour, as the runtime
backstop for refs the collector misses. CloudFront's standard metrics are per distribution, not per
behaviour, so this needs either additional metrics on a dedicated distribution, a metric filter over
real-time or standard logs, or a CloudFront Function that counts misses. Pick the cheapest that can
name the failing path, and let `AssetSupport` create it behind an opt-in prop.

Previews of pages that call the preview hooks themselves are a standing source of that 4xx rate until
[preview-first-paint-public-asset-urls.md](preview-first-paint-public-asset-urls.md) is fixed.
