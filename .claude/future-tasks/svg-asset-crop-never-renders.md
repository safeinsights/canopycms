# An svg asset gets a Crop button whose crop never renders

**Priority:** P3. **Found:** 2026-10-08, review of the image-field `public/` preview fix.

## Problem

`ImageField` shows Crop (and, for a field with `aspect`, opens the crop step on pick or upload) for
any asset-store src. `assetUrl` applies a crop only to a transform src under `/assets/t/`
(`assets/asset-url.ts`, the early return for non-transform srcs). An svg is stored at
`/assets/{hash}/<slug>.svg` (`assets/asset-src.ts`), and the ImageField dropzone accepts
`image/svg+xml`. So an `image` field with `aspect: '1:1'` and an svg value stores a `crop` that
neither the editor preview nor the public build applies, and `entry-validator.ts` accepts it.

## Proposal

Gate Crop and the `'new'` crop step on a transform-src predicate exported from
`assets/asset-url.ts` beside `isAssetStoreSrc`, the same one `assetUrl` uses internally. Test: an
svg asset value with `aspect` shows no Crop button, and picking an svg commits without a crop step.
