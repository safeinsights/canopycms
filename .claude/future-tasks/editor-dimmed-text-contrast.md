---
priority: P2
adopters: BOTH
summary: >-
  Code only: docs/ux-guidelines.md now names `--mantine-color-dimmed` (`gray.7` in light mode) for dimmed text. The theme still leaves it at Mantine's gray.6 (#868e96, 3.32:1 on white), so every `c="dimmed"` label in the editor fails 4.5:1.
---
# Dimmed editor text misses 4.5:1 contrast

[docs/ux-guidelines.md](../../docs/ux-guidelines.md#colour-and-contrast) asks for 4.5:1 and names
`--mantine-color-dimmed` (`gray.7` in light mode) as the only dimmed colour, but the theme's default `--mantine-color-dimmed` (gray.6, `#868e96`) measures 3.32:1 on white in light
mode, so every `c="dimmed"` label fails: upload dates, list metadata and status lines in the
media library, branch "Updated …" lines, comment timestamps, field descriptions.

## Fix

Set `--mantine-color-dimmed` to gray.7 (`#495057`, about 8:1) for light mode in
`CanopyCMSProvider`'s theme (`packages/canopycms/src/editor/theme.tsx`, via `cssVariablesResolver`),
check dark mode separately, and retake the Storybook screenshots of the surfaces it changes.

Related: [filled-button-contrast-and-toast-guidelines.md](filled-button-contrast-and-toast-guidelines.md)
covers the filled confirm buttons.
