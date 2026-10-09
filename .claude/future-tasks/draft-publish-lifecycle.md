---
priority: adopter-side
adopters: KB
summary: >-
  The package half is done: publish state is branch-only and documented (ARCHITECTURE.md, "Publish State Is Branch-Only"). What remains is the KB's own docs, which still list a phantom `draft` frontmatter field that three filters check
---
# Draft/publish: decided, publish state is branch-only; the KB's own docs remain

## Priority: adopter-side, no P-level [KB]

**Decided 2026-08-14 by JP: CanopyCMS will not grow a per-entry draft/published field.** The package
half is done: the contract is stated in ARCHITECTURE.md ("Publish State Is Branch-Only"). What remains
is the KB's own docs and filters, owned by the KB's repo.

## The contract

- **Merged to the base branch means public; unmerged means not public.** There is no third state.
- **`noindex` means public but unadvertised:** the entry is built, its URL resolves for anyone holding
  the link, and it is absent from sitemap, RSS and index grids with `robots: noindex` on the page. It
  is not a hiding mechanism.
- **No enumeration helper invents a publish filter.** `collectStaticPaths`, `collectRoutableEntries`
  and friends filter on `noindex` only; the sitemap and SEO helpers comply
  ([static-export-sitemap.md](resolved/static-export-sitemap.md),
  [static-export-seo-metadata.md](resolved/static-export-seo-metadata.md)).
- **Corollary: don't merge unfinished content.** If it isn't ready, it stays on its branch.

## Why not a per-entry field

- Timed reveal: the sites are statically built by CI, so nothing is visible until a build runs; a
  status field buys nothing.
- Retirement: the delete endpoint already refuses a referenced entry until the editor confirms
  (`api/entries.ts`), an `archived` state would need the same guard, and `git revert` restores a deleted file byte for byte,
  content ID included.
- Editor friction: hiding a page is the same branch flow as any edit.
- Rejected sub-options: a reserved boolean `draft` (absent means published, so a half-written entry
  ships) and an adopter-named field the package filters on (no enforcement).

## What is owed in the KB's own repo

The KB's README and contributor docs tell authors `draft` is a frontmatter field that hides a page.
The schema never declares it, no content sets it, and the editor renders no control for it, yet three
filters (a route guard, a tree-building helper, the search-index builder) check it. A hand-authored
`draft: true` would round-trip through a save and hide the page, but non-technical editors cannot set
it, and nothing tests the filters.

- Correct the README and contributor docs: unfinished content stays on its branch.
- Delete the three filters and the `draft` key in the tree-extract shape.
- Leave the KB's unrelated editorial-workflow status field alone.

The marketing site needs no change: its `isNoindex` predicate is correct under this contract.

## Hand-off: long-lived branches

Branch-only publish makes long-lived content branches legitimate. Per JP, assume some will be, because
reviewers forget them; the guardrails to design are staleness surfacing and recovery, not prevention.
Owned by [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md).

## Related

- [listentries-acl-awareness.md](resolved/listentries-acl-awareness.md): its unpublished-data concern
  is about branch content, not draft-flagged entries.
- [resolved-reference-shape.md](resolved/resolved-reference-shape.md): its "is this visible" question
  dissolves, since within a branch everything is equally visible.
