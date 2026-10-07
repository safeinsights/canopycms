# `assets/` — Assets and media

Asset store v2, the finalize pipeline, and the on-demand transform engine.

The **code comment at the point of the rule is authoritative**; this file is the map to
where those rules live.

## Overview

Asset store v2 (S3/Local adapters, `factory.ts` consumes `media` config), finalize pipeline (sniff/hash/dims/SVG-sanitize, plus a real sharp decode-and-discard check for raster kinds via `pipeline.ts`'s `rasterIsDecodable` — a missing native binary fails open there (logs, skips validation)), and the on-demand transform engine: `transform-directives.ts` (pure/isomorphic directive parser + canonical `formatDirectives`/`canonicalizeTransformPath`), `transform.ts` (server-only, sharp-based `applyTransform`; a sharp load failure rejects, so it is a 500 and never a 422), `sharp-loader.ts` (`loadSharp()`, the package's only runtime load of sharp, memoized including a failure — outside tests, a static value import of sharp is a lint error, because a static import makes every importer of `canopycms/server` or `canopycms/http` load libvips), `asset-url.ts` (pure/isomorphic `assetUrl`/`assetSrcSet`, exported off the package's main entry), `asset-prefixes.ts` (dependency-free bucket-prefix constants so isomorphic modules avoid `keys.ts`'s `node:crypto` import). `materialize.ts` (server-only): `storeTransform` writes one transform output for the raw route, `materializeAssets` and the transform Lambda. The authenticated raw route (`api/assets.ts`) transforms on demand, redirecting S3 reads via `presignPublicObjectRead`; it and the transform Lambda forward `applyTransform`'s real rejection status (400/413/422) rather than flattening it.
