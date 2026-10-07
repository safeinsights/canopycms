# A lazy transform mode that only fills keys a refs manifest names

**Status:** Open. **Priority: P3.** Filed 2026-10-07 as a follow-up of
[image-materialization-epic.md](image-materialization-epic.md). Build it only if an adopter cannot
add the `collect-asset-refs` and `materialize-assets` release steps.

## State

`AssetSupport` has two modes: the default serves only what `materialize-assets` wrote, and
`lazyPublicTransforms: true` lets any anonymous request for a public asset mint a derivative,
bounded by the width allowlist, reserved concurrency and a 180-day expiry, with the crop rectangle
still unbounded.

## Proposal

A third mode: the transform Lambda fills a miss only when the key appears in a refs manifest the
release published (the union of the in-window builds' `canopy-asset-refs.json`), and returns 404
otherwise. That keeps fill-on-miss for adopters without a materialize step while bounding the
anonymous key space to what builds referenced. It still needs the collect step, and the manifest
lookup must be cheap enough not to dominate a miss.
