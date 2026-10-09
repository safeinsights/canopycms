# [P2] The rich-text editor splits bold around a link

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
