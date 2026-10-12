---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED: `CanopyCMSProvider` sets `--mantine-color-dimmed` to `gray.7` in light mode and `dark.1` in dark mode, and the `c="gray.7"` stand-ins in BranchManager, EditorHeader and ToggleField now use `c="dimmed"`.
---
# Dimmed editor text misses 4.5:1 contrast

[docs/ux-guidelines.md](../../../docs/ux-guidelines.md#colour-and-contrast) asks for 4.5:1 and names
`--mantine-color-dimmed` (`gray.7` in light mode) as the only dimmed colour, but the theme's default `--mantine-color-dimmed` (gray.6, `#868e96`) measures 3.32:1 on white in light
mode, so every `c="dimmed"` label fails: upload dates, list metadata and status lines in the
media library, branch "Updated …" lines, comment timestamps, field descriptions.

## Fix

Set `--mantine-color-dimmed` to gray.7 (`#495057`, about 8:1) for light mode in
`CanopyCMSProvider`'s theme (`packages/canopycms/src/editor/theme.tsx`, via `cssVariablesResolver`),
check dark mode separately, and retake the Storybook screenshots of the surfaces it changes.

The rule also rules out stand-ins for the token: `c="gray.7"` twice in
`packages/canopycms/src/editor/BranchManager.tsx` and once in
`packages/canopycms/src/editor/components/EditorHeader.tsx` move to it once the theme is fixed.

Related: [dimmed-text-contrast-and-hover-only-dates.md](dimmed-text-contrast-and-hover-only-dates.md)
found the same token gap, and [filled-button-contrast-and-toast-guidelines.md](filled-button-contrast-and-toast-guidelines.md)
covers the filled confirm buttons.
