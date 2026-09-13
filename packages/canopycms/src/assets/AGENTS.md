# `assets/` — Assets and media

Asset store v2, the finalize pipeline, and the on-demand transform engine.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
108 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

Asset store v2 (S3/Local adapters, `factory.ts` consumes `media` config), finalize pipeline (sniff/hash/dims/SVG-sanitize, plus a real sharp decode-and-discard check for raster kinds via `pipeline.ts`'s `rasterIsDecodable` — a missing native binary fails open there (logs, skips validation)), and the on-demand transform engine: `transform-directives.ts` (pure/isomorphic directive parser + canonical `formatDirectives`), `transform.ts` (server-only, sharp-based `applyTransform`; a sharp load failure rejects, so it is a 500 and never a 422), `sharp-loader.ts` (`loadSharp()`, the package's only runtime load of sharp, memoized including a failure — a static `import sharp` anywhere under `src/` is a lint error, because it loads libvips for every importer of `canopycms/server` or `canopycms/http`), `asset-url.ts` (pure/isomorphic `assetUrl`/`assetSrcSet`, exported off the package's main entry), `asset-prefixes.ts` (dependency-free bucket-prefix constants so isomorphic modules avoid `keys.ts`'s `node:crypto` import). Dev-mode `/assets/t/*` lazy-transform emulation lives in `api/assets.ts`'s raw route; both it and the prod transform Lambda forward `applyTransform`'s real rejection status (400/413/422) rather than flattening it.
