# A component inside a list item is glued onto the item's text after an edit

**Priority:** P3 [MKT]. **Found:** 2026-10-06, marketing-site request 77 (MDXEditor 3.55, measured
offline).

## Problem

`1. item\n\n   <Callout …>x</Callout>` re-serializes as `1. item<Callout …>x</Callout>`: the
component moves from its own block into the item's text, and nothing flags it. No current site body
has a component in a list.

## Next step

Re-measure on MDXEditor 4.3.2 with the round-trip guard from #443, which already routes some
list-item shapes to source. If it still reproduces, add the shape to the round-trip corpus and either
export the component as its own block or route the body to source. Related:
[rich-text-merges-block-paragraphs.md](rich-text-merges-block-paragraphs.md).
