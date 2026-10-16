---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-07, branch `fix/preview-entrypoints`. Host pages import the preview bridge from new `canopycms/preview` / `canopycms-next/preview` entries that reach no CSS or Mantine (`lint:bundle`); example1's `/posts/hello-world` loads 1.26 MB with no Mantine (2.38 MB, 4 Mantine assets, when it imports the editor), asserted in build-verify
---
# Public pages that import `canopycms/client` ship the editor

**Status: RESOLVED 2026-10-07**, branch `fix/preview-entrypoints`, base `int-202610-b`, by the
narrower import rather than `sideEffects`.

- Host pages import the bridge from new `canopycms/preview` and `canopycms-next/preview` entries;
  neither `/client` entry exports it. `PreviewFrame` moved out of `editor/preview-bridge.tsx`,
  so the preview graph holds no editor code even without tree-shaking.
- `pnpm lint:bundle` fails when a `/preview` entry or the bare `canopycms` entry reaches a
  `.css` file or a `@mantine/` module (`host-page-entries-no-editor-styles`). check:esm imports
  both `/preview` entries under plain Node, which rejects CSS.
- Measured in example1's `next build`, scanning the assets `/posts/hello-world.html` loads: 11
  assets, 1.26 MB, none containing `--mantine-`. Importing `CanopyEditorPage` from
  `canopycms/client` into `PostView` gives 18 assets, 2.38 MB, 4 with Mantine, and makes
  `build-verify.test.ts`'s new assertion fail.
- An adopter saw the same gap inside the editor: the preview iframe loaded Mantine's unlayered
  CSS, whose Button rule beat the adopter's CSS-module rules.

## Priority: P2 [BOTH]

Filed 2026-10-05, from the round-1 review of the `createPreviewPage` PR. **Measured** in an
`apps/example1` `next build`. It is pre-existing, and identical in a build made before that PR.

## The gap

`/posts/[slug]/page` ships 12 chunks, about 2.2 MB, 4 of which contain Mantine. A public page
needs only `useCanopyPreview`. It imports that from the `canopycms/client` barrel, which also
exports the editor, and `canopycms` declares no `sideEffects`. So the bundler keeps the editor
modules in the page's client graph.

This works against the goal of a public build with zero editor code (AGENTS.md, deploy shape (b)).
`canopycms-next/client`'s `withCanopyPreview` imports `useCanopyPreview` the same way.

## Proposed solution

Measure first; it may be enough to:
- declare `"sideEffects"` in `packages/canopycms/package.json` (listing any CSS and the
  `'use client'` modules that really have effects); or
- import the preview bridge from a narrower path.

Then add an assertion to `apps/example1/build-verify.test.ts` that a public page's chunks
contain no Mantine.
