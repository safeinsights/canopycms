# Resolved references should carry a URL

## Priority: P2 [KB]

From the 2026-08-13/14 site audits of `../docs-site-proto` and `../website`,
triaged as part of the 2026-08-14 go-live backlog re-baseline. No existing
task file covered this. Tagged **[KB]**: the workaround this removes
(`getDocLinkIndex()`) is docs-site-proto's, and it deploys first.

## Problem

`resolveSingleReference` resolves a reference field to the target entry's
full data (`content-store.ts:1720-1732`), but the resolved shape carries no
URL — just the raw entry data. A page that needs to link to a referenced
entry (e.g. "see also: [Partner Name]" rendering an actual `<a href>`) has no
way to get there from the resolved reference alone.

## The KB's workaround, and its cost

`docs-site-proto` built `getDocLinkIndex()` — a **second full `listEntries`
pass** over the entire content tree, purely to build a
contentId → urlPath lookup table so referenced entries can be linked. This is
expensive (a second full tree walk on every build/request that needs it) and
duplicates work `listEntries` and the reference resolver already do
separately but never combine.

It also forces a page-wide escape hatch: some pages set
`resolveReferences: false` entirely and do their own lookup via the link
index instead, because paying for both a resolved reference AND a separate
URL lookup per reference is worse than just skipping resolution and hand
rolling it.

## Proposed solution

Carry a `urlPath` (or `url`) alongside the resolved reference data —
`resolveSingleReference` already has the target entry loaded, so this is
computing `computeEntryUrl`/the existing URL-derivation path
(`utils/entry-url.ts`) against a resolution it's already doing, not a new
tree walk. This is the same URL-computation path `listEntries` already uses
per-item (`content-listing.ts:132-165`) — reuse it rather than re-deriving.

Once this ships, `getDocLinkIndex()` can be deleted outright (it becomes
strictly redundant with what a resolved reference already carries), and the
page-wide `resolveReferences: false` escape hatch it forced becomes
unnecessary for entries that only needed it for links.

## Related

- [resolved/shared-blocks-listentries-caveat.md](resolved/shared-blocks-listentries-caveat.md) —
  the sibling gap: `listEntries` never resolves references at all. That one
  is about `listEntries`-derived surfaces (search, sitemap); this one is
  about `read()`-derived resolved references not carrying enough to link to.
  RESOLVED (documented) — this file's own gap remains open.
- [draft-publish-lifecycle.md](draft-publish-lifecycle.md) — a resolved
  reference to a draft entry needs the same "should this be visible" answer
  a URL-carrying resolution would need to respect.
