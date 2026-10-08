# Editor tests never run the stack adopters run

## Priority: P2 [BOTH]

## The gap

The editor's unit tests run React 18 and @mdxeditor/editor 3.53.1, from canopycms's own lockfile.
The e2e app builds with Next 15.5's default bundler. Adopters run React 19, MDXEditor 3.55, and
Next 16, which builds with Turbopack.

A crash that depended on how Turbopack's production build splits and scope-hoists MDXEditor was
invisible to every CI layer. See
[turbopack-import-cycle-double-evaluation.md](turbopack-import-cycle-double-evaluation.md). The
JSX e2e spec, `mdx-jsx-body.spec.ts`, passed throughout. It also only ever loads a body on a
page's first render, never through an in-app navigation that lazily loads the editor's chunks.

## Suggested shape

- One CI job building a fixture editor app with Next 16 + Turbopack in production mode, on
  React 19 and the newest MDXEditor the range allows. It opens a non-markdown entry, then
  navigates in-app to an entry whose body has JSX elements with links, and fails on any page
  error.
- Or move the e2e app to Next 16 and add that navigation to `mdx-jsx-body.spec.ts`.
- Decide whether the unit tests should also run against the newest versions in the dependency
  ranges.
