---
priority: P3
adopters: BOTH
summary: >-
  The rich-text editor still shows a URL or email inside inline code as a link (lexical's auto-link runs on code text); the save writes the code as it was. Unlink in the editor too, so it shows what the file holds
---
# [P3] The rich-text editor shows a URL inside inline code as a link

## The gap

lexical's auto-link transform matches text and never sees formats, so a URL or email address in a
code span becomes an `AutoLinkNode` in the editor. The export writes it as code
(`linkExportVisitor` in `editor/fields/markdown-fidelity-visitors.ts`), so nothing reaches disk,
but the editor shows a link the file does not have, and a click on it follows the link.

## Proposal

A node transform that marks an `AutoLinkNode` holding code-formatted text unlinked
(`setIsUnlinked(true)`, which lexical keeps and does not relink), registered on the root and nested
editors. MDXEditor exposes no `@lexical/react` context to our layer, so this needs its editor
subscription cells (`createRootEditorSubscription$`, and nested editors' equivalent) or an upstream
option on `linkPlugin()` to skip code.
