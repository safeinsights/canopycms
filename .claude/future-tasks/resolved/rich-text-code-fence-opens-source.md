# [P2] A code block in an unlisted language, or with a title, opens the whole body as source

**RESOLVED 2026-10-08** by the MDXEditor 4.3.2 upgrade (branch `chore/mdxeditor-4`): a fence in any
language, with or without a meta string, opens in rich text and saves byte for byte (measured;
the four corpus bodies left `ROUTED_TO_SOURCE`).

Found 2026-10-08 by the round-trip corpus test (adopter request 87b).

## The gap

`codeMirrorPlugin` (`editor/fields/MarkdownField.tsx`) matches a fenced block only when its
language is a key of `codeBlockLanguages` and it has no meta string. Any other fence (```` ```http
````, ```` ```ts title="config.ts" ````) has no editor, MDXEditor rejects the document, and
MarkdownField opens the whole body as source. Nothing is lost, but the body cannot be edited as
rich text. The example site's two Users API docs hit it (```` ```http ````). Pinned by
`code-fence-language.md`, `code-fence-meta.md` and those two docs in `ROUTED_TO_SOURCE` in
`markdown-roundtrip-corpus.test.tsx`.

## Proposal

Add a lowest-priority code block descriptor that matches any language and meta, editing the block
as plain text and writing its language and meta back unchanged.
