---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/save-fidelity-edited-blocks`, base `int-202610-b`, but for one shape. The link did keep its bold; the export was `**Read the** [**setup guide**](/docs/setup) **first.**`, which renders the same and means something else. A link export visitor now carries the span on around the link, as MDXEditor's text visitor does between text nodes. Open residual: a link filling the whole span saves as `[**x**](/y)`, see rich-text-link-filling-format-span.md.
---
# [P2] The rich-text editor splits bold around a link

**Status: RESOLVED 2026-10-09**, branch `fix/save-fidelity-edited-blocks`, but for the residual in [rich-text-link-filling-format-span.md](../rich-text-link-filling-format-span.md). The bullet below misread the export: the link keeps its bold, written inside it (`[**setup guide**](/docs/setup)`), with the span split around it. `linkExportVisitor` in `editor/fields/markdown-fidelity-visitors.ts` writes the link inside a bold, italic or struck-through span the text around it shares, and opens one when the text after it continues the format. `strong-link.md` covers bold, italic, strikethrough, two links in one span and a link starting one.

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

MDXEditor keeps formatting on text nodes, and a link or inline code is a separate node, so a
formatted span containing one exports differently:

- `**Read the [setup guide](/docs/setup) first.**` → `**Read the** [setup guide](/docs/setup)
  **first.**`: the link loses its bold.

A save after any edit writes the changed block (the save splice keeps only blocks that mean the
same). Strikethrough around inline code round-trips from MDXEditor 4.3. Pinned by `strong-link.md` in
`packages/canopycms/src/editor/fields/__fixtures__/markdown-corpus`.

## Proposal

Check MDXEditor's export visitors for these nestings, upstream or as an export visitor override.
Failing that, have the round-trip guard reject them so the body opens as source.
