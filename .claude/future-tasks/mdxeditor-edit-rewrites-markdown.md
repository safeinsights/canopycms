# Editing a markdown body rewrites constructs MDXEditor does not preserve

**Priority: P2 [BOTH].** The first edit to a body silently changes parts nobody touched; nothing
reports it, and the save diff is the only trace.

MarkdownField saves MDXEditor's serialization of the whole body after any edit. Measured against
`@mdxeditor/editor` 3.53.1 (a review sweep of every import/export path, with probes in jsdom):

| Stored | Saved after an unrelated edit | Cause |
| --- | --- | --- |
| Hard break (two trailing spaces, or `\` at line end) | Soft break: the rendered `<br>` disappears | `LexicalLinebreakVisitor` exports a `\n` text node |
| Ordered list starting at 3 | Renumbered from 1 | `LexicalListVisitor` exports no `start` |
| `<div className="a"><span className="b">x</span></div>` | `<div className="a b">x</div>` | `collapseNestedHtmlTags` merges a lone `span` child into its parent |
| `<span style={…}><span style="…">x</span></span>` | Inner style only | the inner `addStyle` overwrites the outer one |
| `1. item\n\n   <Callout …>x</Callout>` (a flow JSX element in a list item) | `1. item<Callout …>x</Callout>`: the element joins the item's text | not yet traced. An adopter measured it headless on 3.55 with MarkdownField's plugin set; no live content has it yet |

Already safe: content MDXEditor would lose outright, corrupt, or crash on opens in MarkdownField's
source editor instead (see the round-trip guard in `editor/fields/mdx-jsx-support.tsx`). These five
are subtler: they round-trip into valid but different markdown, so no error fires. The list-item
case could instead route to the source editor, as the guard does for shapes MDXEditor breaks.

## Directions

- Hard breaks and list `start` look like small upstream fixes to MDXEditor's export visitors; check
  its issue tracker, then either upstream them or override the two export visitors in a realm plugin
  (`addExportVisitor$` with a higher priority).
- The two HTML cases could instead be routed to the source editor by the guard, as expression
  attributes already are, if overriding `collapseNestedHtmlTags` is not practical.
- A test per row belongs in `MarkdownField.test.tsx`, asserting the saved text after a typed edit.
