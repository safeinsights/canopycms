---
priority: P3
adopters: BOTH
summary: >-
  Editor surfaces still name fixed palette colours (`bg="white"` in Editor.tsx, plus `gray.0`/`gray.1` backgrounds in ObjectField, BlockField and EditorPanes), which docs/ux-guidelines.md now forbids: text and backgrounds use scheme-aware tokens. Under `colorScheme="dark"` these surfaces stay light
---
# Editor surfaces use fixed colours

[Colour and contrast](../../docs/ux-guidelines.md#colour-and-contrast) has text and backgrounds
use scheme-aware tokens, never a fixed shade. `CanopyCMSProvider` accepts `colorScheme`, but
these call sites hard-code light palette steps:

- `bg="white"` in `Editor.tsx`;
- `bg="gray.0"` and `var(--mantine-color-gray-1)` panel backgrounds (`ObjectField`, `BlockField`,
  `EditorPanes`).

In dark mode the FormRenderer "with comments" story's SEO object group keeps a light background
with near-invisible labels, and the MDX editor body stays white. Move each call site onto
`--mantine-color-body`, `--mantine-color-default-hover` or a `light-dark(…)` surface token in
`theme.tsx`.
