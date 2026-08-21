# Asset URLs are always root-relative, so they 404 under a `basePath` deployment

**Status:** Open. **Priority: P2.** Split out of the adopter's request #24 on 2026-08-20 — their
item bundles it with a documentation gap and a second "behaviour" claim that turned out not to be
one. This is the half that is real code behaviour and was tracked nowhere.

## Problem

`assetSrc()` always emits a root-relative URL — `/assets/…` or `/assets/t/…`. That is deliberate,
and the invariant is load-bearing:

```
packages/canopycms/src/assets/asset-src.ts:15-16
  Always root-relative - media.publicBaseUrl is editor-display-only ... and must never be
  baked into stored/served content URLs.
```

The reasoning is sound for what it was written against: an absolute URL must never end up
*stored in content*, because content moves between branches and environments. `assetUrl`'s
`baseUrl` option exists for the one case it does cover — the editor being served from a different
origin than the public site.

It does not cover a **same-origin subpath** deployment. A Next site configured with `basePath`
serves everything under `/{prefix}/`, and Next only auto-prefixes its own `Image`/`Link`/`Script`
components — never a raw string URL. So a plain `<img src={assetUrl(image)}>` resolves to
`/assets/…` instead of `/{prefix}/assets/…` and 404s.

No basePath-aware handling exists anywhere in `packages/canopycms` or `packages/canopycms-cdk`.

## Why it matters now rather than hypothetically

Preview deployments are the common shape that hits this. An adopter that namespaces preview builds
under `/{previewId}/` via `basePath` gets working pages and broken images, on exactly the builds
reviewers look at. The marketing site already deploys this way for previews; it has not been bitten
only because it has not yet migrated its string image paths to `type: 'image'` fields (see
[adopter-image-field-migration.md](adopter-image-field-migration.md)). Those two tasks collide:
completing the image-field migration is what turns this from latent into visible.

## Options

1. **Document the limitation** — cheapest, and correct regardless of what else happens. Say plainly
   that asset URLs are root-relative and that `basePath` deployments must prefix them, with the
   one-line helper an adopter would write.
2. **A basePath-aware parameter** on `assetUrl`/`assetSrcSet` — a build-time prefix, distinct from
   `publicBaseUrl`'s cross-origin editor semantics. Must not weaken the stored-content invariant:
   the prefix belongs at render time, never in the stored value. Getting that distinction wrong is
   the actual risk here, since `publicBaseUrl` already occupies adjacent conceptual space.

Do (1) now. Do (2) only when an adopter is actually deploying under a subpath, and design it
alongside `publicBaseUrl` rather than as a second, parallel notion of "where assets live".
