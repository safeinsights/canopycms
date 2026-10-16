---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-07, branch `feat/s3-only-public-assets`. `media.publicBaseUrl` is removed outright (no compat shim), with `assetMountUrlSchema` and the `allowProtocolRelative` option that existed only for it; a leftover key fails the strict schema at startup, and the adopter migration guide says to delete it
---
# `media.publicBaseUrl` is validated but nothing reads it

**Status:** RESOLVED 2026-10-07, branch `feat/s3-only-public-assets` (Phase 3 of
[image-materialization-epic.md](image-materialization-epic.md)). Option 1: the key is removed
from every `media` branch and from `MediaConfig`, along with `assetMountUrlSchema` (it had no other
caller) and `isHttpUrlOrSameOriginPath`'s `allowProtocolRelative` option (it existed only for this
key). The strict schema makes a leftover key a startup error, and `docs/adopter-migration.md` says
to delete it.

## State

`media.publicBaseUrl` existed for one consumer: the editor's own asset previews. The editor now
loads every image through the authenticated raw route under `basePath`
(`editor/context/AssetContext.tsx`), and the client config no longer carries the value. Nothing in
the package reads it any more. The schema (`config/schemas/media.ts`, `assetMountUrlSchema` in
`config/schemas/url.ts`) still accepts and validates it, and `utils/sanitize-href.ts` still
describes it as the read-side prefix its `allowProtocolRelative` option exists for.

## Why it was not removed in Phase 1

Every `media` branch is `.strict()`, so deleting the key makes any adopter config that sets it
fail validation at startup. That is a breaking adopter-facing change outside the epic's approved
touchpoint set, so it needs a decision.

## Options

1. **Remove it** (recommended once the epic lands). Drop the key from all three `media` branches
   and from `MediaConfig`, decide whether `assetMountUrlSchema` has any other caller, and add an
   adopter-migration entry telling adopters to delete the key. The strict schema makes the change
   loud rather than silent, which is the right failure for a dead knob.
2. **Repurpose it** as the public site's documented home for its asset origin, read by adopter
   render code as `assetUrl`'s `baseUrl`. Only worth it if Phase 2's collector or materializer
   turns out to need the public origin; otherwise it is a config key the package never reads.
