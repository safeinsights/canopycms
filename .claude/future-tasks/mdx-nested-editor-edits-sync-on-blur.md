# Edits inside a JSX element in a body reach the form only on blur

**Priority: P2 [MKT].** No data loss; the draft, the preview and the Save button lag behind typing.

MarkdownField edits a JSX element's children (`<Callout>…</Callout>`) in an MDXEditor nested
editor. MDXEditor copies a nested editor into the document only on `BLUR_COMMAND` (focus moving
outside the editor UI) or on `NESTED_EDITOR_UPDATED_COMMAND`, so a user who only fixes a typo
inside a Callout sees "No changes to save" and no preview update until focus leaves the element.
Table cells behave the same way.

## What was tried and reverted

A realm plugin that subscribed to the active editor (`createActiveEditorSubscription$`) and
dispatched `NESTED_EDITOR_UPDATED_COMMAND` from each nested update listener. It worked in jsdom
and in most browser runs, but in roughly a third of production-build e2e runs the keystrokes typed
into the Callout produced **no Lexical update at all** on the bound nested editor, although the
text appeared in the DOM. Without the plugin the same keystrokes reached the saved file in 6 of 6
runs. The mechanism was not found, and a change that can stop an editor from seeing keystrokes
was not worth shipping on a UX gain.

## Directions

- Hook each nested editor directly instead of the active editor: a component registered with
  `addNestedEditorChild$` renders inside every nested composer, but reaching that editor needs
  `useLexicalComposerContext` from `@lexical/react`, a direct dependency that would have to match
  MDXEditor's pinned version exactly, or two copies of the context break it.
- Reproduce first: `apps/test-app/e2e/tests/mdx-jsx-body.spec.ts`, editing the Callout before the
  paragraph and asserting Save is enabled, with `--repeat-each=6` on `E2E_PROD_SERVER=1`.
