# [P3] A cropped image field value has no helper for its rendered dimensions

`assetUrl`/`assetSrcSet` apply an `image` field value's `crop`, but the value's `width` and
`height` describe the uncropped original. A site that writes `width={image.width}
height={image.height}` on the `<img>` reserves a box with the original's aspect, not the crop's,
so a cropped image shifts layout or stretches.

The README and `docs/adopter-migration.md` tell adopters to scale by `crop.w` and `crop.h`. Every
adopter will write that multiply by hand.

## Fix direction

Export a pure, isomorphic helper beside `assetUrl` in `assets/asset-url.ts` (for example
`assetDimensions(value)` returning the cropped `{ width, height }`, rounded), and use it in both
READMEs' examples. It adds an export to the main entry, so it needs approval first.
