---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13) — editor surfaces use `--mantine-color-body`, `--canopy-surface-subtle`, `--canopy-surface-muted` and `--mantine-color-default-border`; the MDX editor takes MDXEditor's dark theme in dark mode, and Storybook has a colour-scheme toolbar switch
---
# Editor surfaces use fixed colours

## Status: RESOLVED 2026-10-13

[Colour and contrast](../../../docs/ux-guidelines.md#colour-and-contrast) has text and backgrounds
use scheme-aware tokens, never a fixed shade. `CanopyCMSProvider` accepts `colorScheme`, but
these call sites hard-code light palette steps:

- `bg="white"` in `Editor.tsx`;
- `bg="gray.0"` and `var(--mantine-color-gray-1)` panel backgrounds (`ObjectField`, `BlockField`,
  `EditorPanes`).

In dark mode the FormRenderer "with comments" story's SEO object group keeps a light background
with near-invisible labels, and the MDX editor body stays white. Move each call site onto
`--mantine-color-body`, `--mantine-color-default-hover` or a `light-dark(…)` surface token in
`theme.tsx`.
