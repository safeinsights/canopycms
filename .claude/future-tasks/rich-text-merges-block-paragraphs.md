# [P3] A list item with content after its nested list opens as source

Found 2026-10-08 by the round-trip corpus test (adopter request 87b). The data loss is contained;
what remains is that these bodies cannot be edited in rich text.

## The gap

MDXEditor 4.3.2 still changes some list items, and nothing reports it. `rearrangedBlocks` in
`editor/fields/mdx-jsx-support.tsx` names each case, and the round-trip guard opens such a body as
source:

- **At import.** A nested list moves into a new item after its own (`MdastListVisitor`), so
  whatever follows it comes out before it, and two nested lists swap.
- **At export.** `LexicalListItemVisitor` writes every item tight, so a `---` after a paragraph
  underlines it as a heading, and a paragraph, quote or table after a quote, or a paragraph or table
  after a table, continues the block before it.

Two paragraphs in a list item, and a quote with several blocks, round-trip on 4.3.2; 3.53 merged
both (4.0.2 fixed list items, mdx-editor/editor#936, and 3.54.0 fixed quotes). Other list-item
shapes keep their blocks and lose only looseness, a row in
[mdxeditor-edit-rewrites-markdown.md](mdxeditor-edit-rewrites-markdown.md).

Measured over the repo's 491 tracked markdown files: 26 open as source on 4.3.2, 8 of them by these
rules, and each of those 8 exported something else.

## Options for editing these in rich text

1. **Write items loose where tight changes meaning.** An export visitor that sets `spread` on an
   item whose blocks would run together would fix the export cases, and the looseness row with
   them. Unmeasured.
   - **Cost:** small, an override of `LexicalListItemVisitor`.
   - **Risk:** low; it changes how an item is spaced.
2. **Source islands.** Import a block the guard rejects as a decorator that holds its original
   mdast, exports it verbatim and edits it as markdown in place. The rest of the body stays rich.
   - **Cost:** moderate: a node, an import visitor at the top-level block, an inline source editor
     with re-parse and error display.
   - **Risk:** low for content, since the export is the original.
   - **Gain:** it covers every guard rejection (reference links, fragments, these shapes).
3. **Keep a list's later content in place.** MDXEditor puts a nested list in an item of its own
   with nothing after it (`MdastListVisitor`), so the content that follows would need its own item
   marked as a continuation, plus an export that folds it back. Indent, outdent and Enter know
   nothing of the mark.
   - **Cost:** high.
   - **Risk:** high, for a rare shape.

## Recommendation

Option 1 together with the looseness row, since they share a cause. Option 2 when the source-mode
share across every guard rejection matters. Skip option 3.
