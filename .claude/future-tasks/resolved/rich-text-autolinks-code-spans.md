---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/save-fidelity-edited-blocks`, base `int-202610-b`, for saves. An auto-link holding code-formatted text exports as its text, and adjacent inline code joins into one span, so code holding a URL or an email address saves as written. The editor still shows the link inside the code span: rich-text-code-span-url-shown-as-link.md.
---
# [P2] The rich-text editor turns a URL inside inline code into a link

**Status: RESOLVED 2026-10-09**, branch `fix/save-fidelity-edited-blocks`, for saves; the display half is [rich-text-code-span-url-shown-as-link.md](../rich-text-code-span-url-shown-as-link.md). lexical's matchers see text only, and the auto-link plugin is unreachable from our layer (it sits behind MDXEditor's own `@lexical/react`), so the fix is at export: `linkExportVisitor` writes an auto-link with any code-formatted child as its children, and `inlineCodeJoinVisitor` joins the code spans either side. Email addresses in code had the same bug and are covered too. `code-span-url.md` covers a whole-span URL, a URL mid-span and an email.

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
