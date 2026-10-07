# `collect-asset-refs`: third-party static lookalikes, and no lazy-mode width check

**Status:** Open. **Priority: P3.** Filed 2026-10-07 from the final review of
[image-materialization-epic.md](resolved/image-materialization-epic.md).

## State

- **Static false positives.** `build/asset-refs.ts`'s static-URL pattern matches any
  `/assets/<32 hex>/<name>.<ext>`, whatever origin precedes it. A third-party URL of that shape in
  the build output (an md5-named CDN file, an embedded widget) becomes a static key, so
  `materialize-assets` reports a content failure and the release fails unless
  `--allow-failures` is passed. Transform URLs are safe, because their directive grammar is
  specific to canopy.
- **Lazy-mode widths are unchecked.** `assetSrcSet` and the raw route accept any width from 1 to
  8192, but the lazy Lambda accepts only its allowlist. `assetSrcSet(ref, [300])` works in dev, the
  editor and preview, and returns 400 on the public path in lazy mode. Nothing catches that before
  production.

## Proposal

- Treat a static match that is absolute on another origin as a warning, or accept statics only
  when root-relative or on a configured origin.
- Add `--width-policy allowlist` to `collect-asset-refs`, so a lazy-mode adopter can fail a build
  on off-allowlist widths.
