---
priority: P3
adopters: BOTH
summary: >-
  A link that is the whole of a bold, italic or struck-through span (`**[guide](/g)**`) saves as `[**guide**](/g)` after an edit to its block: lexical keeps formats on text, so the two spellings import alike. Renders the same; changes the block's text
---
# [P3] A link filling a formatted span saves with the format inside it

## The gap

`**[guide](/docs/guide)**` and `[**guide**](/docs/guide)` import to the same lexical nodes: a link
whose text is bold. `linkExportVisitor` (`editor/fields/markdown-fidelity-visitors.ts`) writes a
link inside a span only when text next to it shares the format, so a link with no such neighbour
keeps MDXEditor's spelling, the format inside the link. Both render the same, but the block's
mdast differs, so a save after an edit to that block writes the other spelling.

## Proposal

Record which spelling was imported: an import visitor that marks a link imported as the only child
of a format container (a lexical node state on the link), read back by `linkExportVisitor`. Low
value unless an adopter's content uses the outer spelling widely; check a corpus first.
