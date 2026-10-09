---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-08, from the round-trip corpus test. MDXEditor parses `.md` bodies as MDX, so an HTML comment, a `{` or a `<placeholder>` opens the body as source. Give `.md` bodies markdown-only parsing
---
# [P2] The rich-text editor parses a .md body as MDX, so an HTML comment opens it as source

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

MDXEditor always parses with its MDX syntax extensions, whatever the file's extension. Valid
markdown that is not valid MDX fails the import, and MarkdownField opens the body as source: an
HTML comment (`<!-- note -->`), a `{` in prose, or a placeholder such as `<name>`. Nothing is lost,
but common markdown cannot be edited as rich text. Pinned by `html-comment.md` in `ROUTED_TO_SOURCE`
in `markdown-roundtrip-corpus.test.tsx`.

## Proposal

Pass the body's format to MarkdownField and, for `.md`, give MDXEditor markdown-only parsing
(`suppressHtmlProcessing`, and no MDX syntax extensions), then check which constructs that loses.
