# `buildContentTree` still silently drops unparseable-filename entries at build time

**Priority:** P2 — same failure class as a fixed P1, narrower blast radius
**Found:** 2026-08-14, static-generation review fix session (fix/static-gen-review-findings)

## Problem

`content-listing.ts`'s `listEntries()` now throws during an actual production build
(`isBuildMode()`) when a collection directory contains a file with a recognized content
extension (`.md`/`.mdx`/`.json`/`.yaml`) whose name doesn't match the
`{type}.{slug}.{id}.{ext}` grammar — previously it was dropped silently, with no output
unless `CANOPYCMS_DEBUG=true`. See `listEntries`'s doc comment and the
`SkippedListingFile`/`onSkip` plumbing added to `listCollectionEntries`.

That fix was deliberately scoped to `listEntries()` only, because that is the function the
static-generation surfaces (`collectStaticPaths`, `collectRoutableEntries`, and therefore
`generateContentStaticParams`/`generateContentSitemap`) actually call. `listCollectionEntries`
itself still silently skips (the `onSkip` callback is optional and off by default), and its
two other callers were out of scope for that session:

- `content-tree.ts`'s `buildContentTree` (~line 269) — used to build hierarchical content
  trees (nav menus, docs sidebars, etc.). An adopter driving static generation off a content
  tree instead of `listEntries` would still see a page vanish with zero build output.
- `api/entries.ts`'s local `listCollectionEntries` wrapper — an admin/API listing path, not a
  build-time surface, so the case for a hard build-time failure there is weaker (there is no
  "build" to fail — though a debug-gated silent skip is still not obviously right for an admin
  UI either).

## Suggested fix

Thread the same `onSkip` callback (or an equivalent) through `buildContentTree`, and apply the
same `isBuildMode()` red-build guard there that `listEntries` now has — likely by extracting
the "collect skips, throw in build mode" logic `listEntries` added into a small shared helper
both functions call after their own `Promise.all`. Decide separately whether `api/entries.ts`'s
admin listing path should also surface skips more visibly (even outside build mode, since it
has no "silently drop and rebuild" recovery story of its own) — that's a UX call, not a
build-correctness one, so it can land independently.
