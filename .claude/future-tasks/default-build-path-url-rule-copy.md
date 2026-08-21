# `defaultBuildPath` is a third copy of the entry-URL rule

**Status:** Open. **Priority: P3** — no known divergence today; this is drift insurance plus
one undocumented edge.

## What

The "where does this entry live?" rule — strip the content root, collapse an `index` slug to
its parent, lowercase — now has two implementations:

1. `computeEntryUrl` (`utils/entry-url.ts`), used by `listEntries` for `item.urlPath`, by
   reference resolution for a resolved reference's `urlPath`, and by `entry-link-resolver.ts`
   for `entry:ID` links.
2. `defaultBuildPath` (`content-tree.ts`), which `buildContentTree` uses for node paths and
   which is **exported** so adopters can extend rather than reimplement it.

They were verified to agree across nested collections, root index, a collection literally
named `index`, an entry slugged `index` inside one, mixed case, dotted slugs, multi-segment
content roots, and an empty content root. Nothing is broken. But two copies of one rule is
what the adopter migration guide names as the failure mode, and #1 was consolidated from two
copies to one on exactly that reasoning — leaving a third undercuts it.

## Why it was not folded in with the rest

`defaultBuildPath` takes a full `logicalPath` plus a `kind`, and handles `kind: 'collection'`,
which `computeEntryUrl` does not model. Delegating the entry case means splitting the last
path segment off as the slug (safe — slugs cannot contain `/`) and keeping the inline logic
for collections. That is a change to an exported, adopter-extensible API, which wants its own
review rather than riding along with a finding ranked non-blocking.

## The undocumented edge, worth fixing either way

`buildContentTree` accepts a custom `buildPath` that **replaces** `defaultBuildPath`. With
`resolveReferences: true`, a tree node's own path then comes from the adopter's function while
any resolved reference's `urlPath` inside that node's data still comes from `computeEntryUrl`
— so the two can legitimately disagree within one tree, and no doc says so. Note that
`listEntries` has no such option, so this is specific to the tree.

Either state the divergence in the `buildPath` option docs, or have resolution take the same
override.

## Related

- [resolved-reference-shape.md](resolved/resolved-reference-shape.md) — added the resolved
  reference `urlPath` and consolidated the listing's copy of the rule.
- [url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md) —
  RESOLVED 2026-08-21. The *reverse* direction (URL → entry) had been disagreeing with this rule
  about how many URLs an index entry answers at; it now agrees. Different bug, same theme — and
  the reason this file's remaining copy matters more, not less: the reverse resolver is now
  written to match the forward rule, so a third forward implementation drifting is a way to break
  routing, not just tree paths.

[NEITHER]
