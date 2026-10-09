# Editor previews of `public/` image paths miss under a Next `basePath`

**Priority:** P3. **Found:** 2026-10-08, claims pass on the image-field `public/` preview fix.

## Problem

`editorImageSrc` (`editor/media/editor-image-src.ts`) shows a src outside the asset store at its own
root-relative path. A Next app with a `basePath` serves `public/` files under that prefix, so an
editor at `/p` previews `/people/x.png` where the file lives at `/p/people/x.png`, and both the
`image` field and MDX body previews show "Preview unavailable". The public site avoids this by
passing `baseUrl: BASE_PATH` to `assetUrl`, which prefixes every root-relative src
(`assets/asset-url.ts`, the `joinUrlPrefix` branch). No current adopter sets a `basePath`.

## Proposal

Carry `basePath` in `AssetContext` (it already receives it to build the raw route) and resolve a
root-relative non-store src with `assetUrl({ src }, { baseUrl: basePath })`. Test: under
`AssetContextProvider basePath="/p"`, an `image` field with `src: '/logos/x.svg'` previews
`/p/logos/x.svg`, and off-site and `data:` srcs stay as written.
