---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-08, from the round-trip corpus test. MDXEditor drops an ordered list's `start` on import and export, so `3.` saves as `1.` after any edit. Carry `start` through import and export visitors
---
# [P2] The rich-text editor renumbers an ordered list that does not start at 1

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

MDXEditor drops an ordered list's `start` both ways: `MdastListVisitor` creates the lexical list
node without it, and `LexicalListVisitor` exports a list with none. So
`3. Pick a branch.` exports as `1. Pick a branch.`. Lists split by a paragraph and numbered on
(`4.`, `7.`) and lists starting at `0.` are renumbered the same way. A save after any edit writes
the renumbered list. Pinned by `ordered-list-start.md` in
`packages/canopycms/src/editor/fields/__fixtures__/markdown-corpus`.

## Proposal

An import visitor and an export visitor, at a higher priority than MDXEditor's, that carry `start`
through the lexical list node (which has one), or an upstream fix.
