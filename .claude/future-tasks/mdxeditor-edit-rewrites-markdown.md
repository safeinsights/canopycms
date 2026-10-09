---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-06, measured. The first edit to a markdown body re-serializes it through MDXEditor, which turns hard breaks into soft ones, renumbers ordered lists from 1, merges a lone span's class into its parent, writes loose lists tight, and autolinks a bare URL's trailing period into its target. Valid but different markdown, so no error fires. Override the export visitors or upstream the fixes
---
# Editing a markdown body rewrites constructs MDXEditor does not preserve

**Priority: P2 [BOTH].** The first edit to a body silently changes parts nobody touched; nothing
reports it, and the save diff is the only trace.

MarkdownField saves MDXEditor's serialization of the whole body after any edit. Measured against
`@mdxeditor/editor` 3.53.1 (a review sweep of every import/export path, with probes in jsdom), and
re-measured the same on 4.3.2:

| Stored | Saved after an unrelated edit | Cause |
| --- | --- | --- |
| Hard break (two trailing spaces, or `\` at line end) | Soft break: the rendered `<br>` disappears | `LexicalLinebreakVisitor` exports a `\n` text node |
| Ordered list starting at 3 | Renumbered from 1 | `LexicalListVisitor` exports no `start` |
| `<div className="a"><span className="b">x</span></div>` | `<div className="a b">x</div>` | `collapseNestedHtmlTags` merges a lone `span` child into its parent |
| A bare URL followed by punctuation: `See https://example.com/docs. Then`, `www.example.org.` | `[https://example.com/docs.](https://example.com/docs.)`, `[www.example.org.](https://www.example.org.)`: the link gains the period (and a scheme) | the link plugin's autolinking, which also turns every bare URL into `[url](url)`; measured in jsdom 2026-10-08 |
| A loose list (a blank line between items, or between an item's blocks) | Tight: items lose their `<p>` | `LexicalListVisitor` and `LexicalListItemVisitor` export `spread: false`; measured on 3.53.1 and 3.55.0 |

A save now keeps the on-disk text of every block whose meaning the export keeps
(`utils/markdown-body-splice.ts`), so marker and escape restyling no longer reaches disk. These rows
still do, untouched or not: each changes the block's meaning, and the save follows the editor's
meaning. Fixing them at the export is what removes them.

Already safe: content MDXEditor would lose outright, corrupt, or crash on opens in MarkdownField's
source editor instead (see the round-trip guard in `editor/fields/mdx-jsx-support.tsx`). These five
are subtler: they round-trip into valid but different markdown, so no error fires.

## Directions

- From MDXEditor 4.0.2 a list item's second paragraph imports as two line breaks, so Backspace at
  its start leaves one, which saves as a soft break: the hard-break row's cause (reasoned from the
  visitors, not measured; jsdom has no `Selection.modify`).
- Hard breaks and list `start` look like small upstream fixes to MDXEditor's export visitors; check
  its issue tracker, then either upstream them or override the two export visitors in a realm plugin
  (`addExportVisitor$` with a higher priority).
- The two HTML cases could instead be routed to the source editor by the guard, as expression
  attributes already are, if overriding `collapseNestedHtmlTags` is not practical.
- A test per row belongs in `MarkdownField.test.tsx`, asserting the saved text after a typed edit.
