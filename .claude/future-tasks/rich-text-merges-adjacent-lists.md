# [P3] The rich-text editor merges two adjacent lists into one

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

In markdown, a bullet list followed by one with a different marker (`-` then `*`) is two lists. The
rich-text editor exports them as one: `@lexical/list`'s list node transform
(`mergeNextSiblingListIfSameType`) merges a list into the one before it when both have the same
type. So the first edit anywhere in the body saves them merged.
Rare in hand-written content, but a change of meaning. Pinned by `adjacent-lists.md` in `KNOWN_EXPORT_DIFFERENCES` in
`markdown-roundtrip-corpus.test.tsx`.

## Proposal

Keep the lists apart through the import (a marker the transform does not merge across) and write
them back as two, or have the round-trip guard open such a body as source.
