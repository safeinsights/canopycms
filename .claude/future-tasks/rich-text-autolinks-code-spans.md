---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-08, from the round-trip corpus test. `linkPlugin()`'s auto-link turns a URL inside inline code into a link, splitting the code span; a save after any edit writes it. Skip code-formatted text when auto-linking
---
# [P2] The rich-text editor turns a URL inside inline code into a link

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

`linkPlugin()`'s auto-link transform (`MarkdownField.tsx`) runs on code-formatted text too, so
`` `https://example.com/org/repo.git` `` exports as
``[`https://example.com/org/repo.git`](https://example.com/org/repo.git)``. A code span holding a
URL and more (`` `curl -fsSL https://… | bash -` ``) is split into three spans around the link. A
save after any edit writes it. Pinned by `code-span-url.md` in
`packages/canopycms/src/editor/fields/__fixtures__/markdown-corpus`.

## Proposal

Keep auto-linking typed URLs but not code: a matcher that skips code-formatted text nodes, or
`linkPlugin({ disableAutoLink: true })` if typed auto-linking is not worth that. A bare URL in plain
text already round-trips (the save splice treats it and its auto-link as the same block).
