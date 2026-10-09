---
priority: P3
adopters: BOTH
summary: >-
  Markdown inserted into the rich-text editor (MDXEditor's `insertMarkdown$`) loses an ordered list's `start`: the import visitor finds the list it made only under an element node. Unreachable today; the only inserter writes a link
---
# [P3] An ordered list inserted as markdown loses its start

## The gap

`listStartImportVisitor` (`editor/fields/markdown-fidelity-visitors.ts`) lets MDXEditor's visitor
create the list, then finds it under `lexicalParent` to set its `start`. Under `insertMarkdown$`,
`lexicalParent` is MDXEditor's import point, not an element node, so the visitor finds no list and
the inserted list starts at 1. Nothing inserts a list today: the only inserter is the entry-link
toolbar button, which inserts a link.

## Proposal

When `lexicalParent` is not an element, take the list from the import point's collected children
(`lexicalParent.children.at(-1)` in MDXEditor 4.3.2's `plugins/core/index.js`), or set the start
from a node transform instead. Do it when a toolbar action first inserts markdown that can hold a
list.
