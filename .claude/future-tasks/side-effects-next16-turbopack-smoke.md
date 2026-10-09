# Smoke-test the editor under Next 16 Turbopack with `sideEffects` declared

**Status:** Open. **Priority: P3.** Filed 2026-10-09 from
[root-entry-tree-shaking.md](resolved/root-entry-tree-shaking.md).

## State

`packages/canopycms/package.json` declares `sideEffects`, so bundlers drop any canopycms module
whose exports go unused unless it is listed. The listed modules are the editor theme (its Mantine
and mdxeditor CSS imports), the CLI bin, and two test-utils files.

Verified so far:

- example1's webpack production build still emits the Mantine and mdxeditor CSS, and
  `build-verify` passes.
- An example1 `next build --turbopack` + `next start` renders `/edit` styled, with no console
  errors.

Both of those ran on Next 15.5. Every app in this workspace pins Next 15.5, while `canopycms-next`'s
peer range admits Next 16. Next 16 Turbopack has not been checked. Turbopack's `sideEffects`
handling differs from webpack's, so a CSS import it drops would leave the editor unstyled with no
build error.

## Task

Build an app on Next 16 with Turbopack against the packed tarball (`pnpm pack`, not the workspace
link) and load `/edit`. Confirm that the Mantine and mdxeditor styles apply and that the console is
clean. If the workspace gains a Next 16 app, make this a CI check rather than a one-off.
