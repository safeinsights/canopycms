# Adopter-registered MDX components for markdown/mdx body fields

**Priority: P3 [BOTH]. Deferred 2026-10-06.** Design this together with
[mdx-preview-executes-editor-code.md](mdx-preview-executes-editor-code.md), not on its own.

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
- **One registry, three consumers.** The preview task proposes a fixed component allowlist for a
  non-executing preview renderer, plus an optional save-time rejection of unlisted tags, `{expressions}`
  and ESM. This list is that allowlist. Settle that task's trust-model decision first; it decides
  fields this config needs, for example whether a component may render in the preview.
- **Attribute fidelity.** MDXEditor's prop editing rebuilds an element's attributes from the
  descriptor's props, so expression, spread or boolean attributes not declared as props would be
  dropped on edit. Registered components need either complete prop declarations or a guard that
  routes undeclared attribute shapes to source, as the catch-all's round-trip guard does today.

## Why it was deferred

The catch-all removed the data-loss reason for doing it, no adopter has asked for typed component
editing, and building the registry before the preview trust model would likely get its shape wrong.
