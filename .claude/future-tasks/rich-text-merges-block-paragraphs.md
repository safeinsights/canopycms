# [P2] Multi-paragraph list items and quotes open as source

Found 2026-10-08 by the round-trip corpus test (adopter request 87b). Contained the same day: the
data loss is gone, and what remains is that these bodies cannot be edited in rich text.

## The gap

MDXEditor 3.53.1 merges or reorders the blocks of a list item or quote, and nothing reports it.
`rearrangedBlocks` in `editor/fields/mdx-jsx-support.tsx` names each case, and the round-trip guard
opens such a body as source. The cases:

- **List items, at import.** A paragraph's text goes straight onto its list item
  (`lexicalTypesThatShouldSkipParagraphs` in `MdastParagraphVisitor`), so two paragraphs join with
  no space. A nested list moves into a new item after its own (`MdastListVisitor`), so whatever
  follows it comes out before it, and two nested lists swap.
- **List items, at export.** `LexicalListItemVisitor` writes every item tight, so a `---` after a
  paragraph underlines it as a heading, and a paragraph, quote or table after a quote, or a
  paragraph or table after a table, continues the block before it.
- **Quotes.** The import joins a quote's paragraphs the same way, and `LexicalQuoteVisitor` exports
  all of its blocks as one paragraph.

Elsewhere, an export keeps the content and loses only looseness; that is a row in
[mdxeditor-edit-rewrites-markdown.md](mdxeditor-edit-rewrites-markdown.md).

Cost of the containment, measured over the repo's 491 tracked markdown files:

| MDXEditor | Newly open as source | Of those, already exporting something else | Safe, now source |
| --------- | -------------------- | ------------------------------------------ | ---------------- |
| 3.53.1 (our lockfile) | 20 | 20 | 0 |
| 3.55.0 (adopters' latest 3.x) | 22 | 17 | 5 (multi-block quotes) |

The quote rule is needed through 3.53.1 and over-rejects from 3.55.0, where quotes round-trip. Our
range `^3.52.4` admits both, so the rule stays until the floor moves (see
[editor-tests-miss-adopter-runtime-stack.md](editor-tests-miss-adopter-runtime-stack.md)).

## Options for editing these in rich text

1. **Upgrade to MDXEditor 4.3.** 4.0.2 imports a list item's later paragraphs as two line breaks,
   which export as a blank line (upstream issue mdx-editor/editor#936). 3.54.0's release notes list
   a quote fix too, and quotes measure clean on 3.55.0. Its only breaking change is the Sandpack
   plugin, which we do not use, but it moves Lexical from 0.35 to 0.48. 4.3.2 still has the
   nested-list reorder and the tight export, so those rules stay. None of this is measured on 4.x
   yet; the shape cases in `markdown-roundtrip-corpus.test.tsx` are the measurement.
   - **Cost:** a dependency bump with a lockfile graft, then the corpus, the shape cases and the e2e
     suite on 4.3.
   - **Risk:** medium. Thirteen Lexical minors, and MarkdownField's Turbopack import-cycle
     workaround to re-check.
   - **Gain:** the common case, a bullet with two paragraphs, plus every multi-block quote, and our
     tests run what adopters run.
2. **Backport 4.0.2's import in a realm plugin.** Add a paragraph visitor with priority above
   MDXEditor's that inserts the two line breaks.
   - **Cost:** small.
   - **Risk:** it relies on the line-break export writing `\n` text. That is the hard-break bug in
     [mdxeditor-edit-rewrites-markdown.md](mdxeditor-edit-rewrites-markdown.md), so fixing that bug
     breaks this. Throwaway once option 1 lands.
3. **Keep a list's later content in place.** Lexical keeps a nested list in an item of its own,
   with nothing after it, so the content that follows would need its own item marked as a
   continuation, plus an export that folds it back. Indent, outdent and Enter know nothing of the
   mark.
   - **Cost:** high.
   - **Risk:** high, for a rare shape.
4. **Nested editors per item or quote.** A decorator node with a `NestedLexicalEditor`, as JSX
   elements have.
   - **Cost:** high.
   - **Risk:** list keyboard behaviour (Tab, Enter, merging items) stops at the item boundary.
5. **Source islands.** Import a block the guard rejects as a decorator that holds its original
   mdast, exports it verbatim and edits it as markdown in place. The rest of the body stays rich.
   - **Cost:** moderate: a node, an import visitor at the top-level block, an inline source editor
     with re-parse and error display.
   - **Risk:** low for content, since the export is the original.
   - **Gain:** it covers every guard rejection (code-fence languages, reference links, fragments,
     these shapes), not just this one.

## Recommendation

Option 1 first, as its own PR: it fixes the shapes adopters actually write, closes the version skew,
and lets the corpus decide which rules can go. Then option 5, if the source-mode share still
matters, because it reduces every whole-body fallback rather than this one. Skip options 2-4.
