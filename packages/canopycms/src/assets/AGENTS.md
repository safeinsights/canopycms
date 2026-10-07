# `assets/` — Assets and media

Asset store v2, the finalize pipeline, and the on-demand transform engine.

The **code comment at the point of the rule is authoritative**; this file is the map to
where those rules live.

## Overview

Asset store v2 (S3/Local adapters, `factory.ts` consumes `media` config), finalize pipeline (`pipeline.ts`: sniff/hash/dims/SVG-sanitize, then `rasterIsDecodable`'s real sharp decode), and the on-demand transform engine: `transform-directives.ts` (pure/isomorphic parser, `formatDirectives`/`canonicalizeTransformPath`), `transform.ts` (server-only `applyTransform`), `sharp-loader.ts` (`loadSharp()`, the only runtime load of sharp; a static import is a lint error), `asset-url.ts` (pure/isomorphic `assetUrl`/`assetSrcSet`, off the main entry), `asset-prefixes.ts` (bucket-prefix constants without `keys.ts`'s `node:crypto`). The raw route (`api/assets.ts`) transforms on demand and redirects S3 reads via `presignPublicObjectRead`; it and the transform Lambda forward `applyTransform`'s rejection status (400/413/422) unchanged.

## Create-only writes

`putOriginal`, `putPublicObject`, `copyPublicObject` and `putMetaIfAbsent` return `CreateOnlyResult` (`types.ts`). S3 funnels them through `createIfAbsent` (`store-s3.ts`, `IfNoneMatch: '*'`); local through `createExclusive` (`store-local.ts`: a temp file under `.asset-tmp/`, then `link()`), except `putMetaIfAbsent`'s `wx` open. In canopycms-cdk, `AssetSupport`'s `enforceCreateOnlyWrites` denies every unconditional put to the content-addressed prefixes.

## Materialize

`materialize.ts` (server-only): `storeTransform` writes one transform output for the raw route, `materializeAssets` and the transform Lambda. `materializeAssets` (exported from `canopycms/server`, run by `cli/asset-refs.ts`) writes each key `k` at `outputPrefix + k` when given one (`assertValidOutputPrefix` guards it); `resolvePresence` sorts each key into `dest`/`canonical`/`absent`, copying a `canonical` one and transforming an `absent` one. The report carries `schemaVersion` (`MATERIALIZE_REPORT_SCHEMA_VERSION`).
