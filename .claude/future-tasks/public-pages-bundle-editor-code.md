# Public pages that import `canopycms/client` ship the editor

## Priority: P2 [BOTH]

Filed 2026-10-05, from the round-1 review of the `createPreviewPage` PR. **Measured** in an
`apps/example1` `next build`. It is pre-existing, and identical in a build made before that PR.

## The gap

`/posts/[slug]/page` ships 12 chunks, about 2.2 MB, 4 of which contain Mantine. A public page
needs only `useCanopyPreview`. It imports that from the `canopycms/client` barrel, which also
exports the editor, and `canopycms` declares no `sideEffects`. So the bundler keeps the editor
modules in the page's client graph.

This works against the goal of a public build with zero editor code (AGENTS.md, deploy shape (b)).
`canopycms-next/client`'s `CanopyPreviewView` imports `useCanopyPreview` the same way.

## Proposed solution

Measure first; it may be enough to:
- declare `"sideEffects"` in `packages/canopycms/package.json` (listing any CSS and the
  `'use client'` modules that really have effects); or
- import the preview bridge from a narrower path.

Then add an assertion to `apps/example1/build-verify.test.ts` that a public page's chunks
contain no Mantine.
