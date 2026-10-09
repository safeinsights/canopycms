# [P1] The rich-text editor merges the paragraphs of a list item or quote, and a save writes it

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

MDXEditor imports a paragraph inside a list item or a blockquote as bare inline content of that
node (`lexicalTypesThatShouldSkipParagraphs` in its `MdastParagraphVisitor`), so a list item or
quote with two paragraphs comes back as one, with no space between them. Text after a nested list
moves above it:

```md
- The second item has a nested list, then more text:
  - nested one

  Text after the nested list, still in the second item.
```

exports as `- The second item has a nested list, then more text:Text after the nested list, still
in the second item.` followed by the nested list.

The import reports nothing, so the body opens in rich text. The first edit anywhere in it sends the
whole export, and the save splice (`utils/markdown-body-splice.ts`) keeps a block from disk only
when it means the same, so the merged list or quote is written over the original. Repo docs hit it
widely (multi-paragraph bullets are common).

Pinned by `list-item-paragraphs.md` and `quote-paragraphs.md` in
`packages/canopycms/src/editor/fields/__fixtures__/markdown-corpus`, listed in
`KNOWN_EXPORT_DIFFERENCES` in `markdown-roundtrip-corpus.test.tsx`.

## Proposal

Contain it first: have the round-trip guard (`editor/fields/mdx-jsx-support.tsx`) reject a list
item or blockquote with more than one block child that is not a list, so the body opens as source.
Then look for an upstream fix or an import visitor that keeps the paragraphs.
