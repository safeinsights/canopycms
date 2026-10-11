---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-11, from WS7a-1's UX review. Mantine's default dimmed colour (#868e96 on white) measures 3.32:1, under the 4.5:1 docs/ux-guidelines.md asks for, and about 39 editor files use `c="dimmed"`; fix it once in the theme rather than per component
---
# Dimmed editor text misses 4.5:1 contrast

`docs/ux-guidelines.md` says "Text contrast is at least 4.5:1 … Check dimmed xs text", but the
theme's default `--mantine-color-dimmed` (gray.6, `#868e96`) measures 3.32:1 on white in light
mode, so every `c="dimmed"` label fails: upload dates, list metadata and status lines in the
media library, branch "Updated …" lines, comment timestamps, field descriptions.

## Fix

Set `--mantine-color-dimmed` to gray.7 (`#495057`, about 8:1) for light mode in
`CanopyCMSProvider`'s theme (`packages/canopycms/src/editor/theme.tsx`, via `cssVariablesResolver`),
check dark mode separately, and have the guideline name the token so components never override
it one by one. Retake the Storybook screenshots of the surfaces it changes.

Related: [filled-button-contrast-and-toast-guidelines.md](filled-button-contrast-and-toast-guidelines.md)
covers the filled red confirm buttons.
