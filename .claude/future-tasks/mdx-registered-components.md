---
priority: P3
adopters: BOTH
summary: >-
  Deferred 2026-10-06. Adopter-registered MDX components (`editor.mdxComponents` with typed props → MDXEditor descriptors: prop editors, toolbar insert). Bodies already edit any JSX through the catch-all; design it with the non-executing preview renderer, whose component allowlist this list would be
---
# Adopter-registered MDX components for markdown/mdx body fields

**Priority: P3 [BOTH]. Deferred 2026-10-06.** Design this together with
[mdx-non-executing-preview-renderer.md](mdx-non-executing-preview-renderer.md), not on its own. The
trust model it waited on is settled: see
[resolved/mdx-preview-executes-editor-code.md](resolved/mdx-preview-executes-editor-code.md).

## Where things stand

MarkdownField loads and edits any JSX element in a body through a catch-all MDXEditor descriptor
(`editor/fields/mdx-jsx-support.tsx`). Each element shows its tag and attributes read-only, its
children are editable in place, and its attributes are edited in source mode. Nothing is lost; what
is missing is authoring polish.

## The proposal

Adopters list their components once, with typed props:

```ts
editor: {
  mdxComponents: [
    { name: 'Callout', kind: 'flow', children: true,
      props: [{ name: 'type', type: 'select', options: ['info', 'warning'] },
              { name: 'title', type: 'string' }] },
  ],
}
```

MarkdownField maps each entry to an MDXEditor `jsxComponentDescriptor`, giving listed components
prop editors and an insert-from-toolbar entry. Unlisted tags keep the catch-all.

## Design constraints

- **Plain data, shared config.** The list holds names, kinds and prop types, not React components, so
  it can live in the shared config and reach the editor through `config.client()`. It does not belong
  in `ClientOnlyFields`: the server needs the same list for the uses below.
- **One registry, three consumers.** The editor, the non-executing preview renderer
  ([mdx-non-executing-preview-renderer.md](mdx-non-executing-preview-renderer.md)), and the
  save-time policy in `validation/markdown-safety.ts`. That policy accepts any plainly named component
  today, and this list could narrow it to the registered ones.
- **Attribute fidelity.** MDXEditor's prop editing rebuilds an element's attributes from the
  descriptor's props, so expression, spread or boolean attributes not declared as props would be
  dropped on edit. Registered components need either complete prop declarations or a guard that
  routes undeclared attribute shapes to source, as the catch-all's round-trip guard does today.

## Why it was deferred

The catch-all removed the data-loss reason for doing it, no adopter has asked for typed component
editing, and building the registry before the preview trust model would likely get its shape wrong.
