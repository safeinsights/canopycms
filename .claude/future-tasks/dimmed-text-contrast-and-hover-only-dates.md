---
priority: P2
adopters: BOTH
summary: >-
  Two editor-wide a11y gaps the WS6-lite UX review found. Mantine's `dimmed` colour (#868e96) on white is about 3.3:1 at 12px, under the 4.5:1 docs/ux-guidelines.md requires, and `c="dimmed"` xs text is everywhere (timestamps, "Updated …", "Owner:"). And `components/RelativeTime.tsx` puts the absolute date in a Tooltip on a non-focusable `<time>`, so keyboard and screen-reader users never get it.
---

# Dimmed text contrast, and absolute dates only on hover

## What is known

- Contrast: overriding `--mantine-color-dimmed` to gray.7 in `editor/theme.tsx` fixes every
  surface at once; check it against the shell's backgrounds (gray.0 panels) too.
- RelativeTime: options are visually hidden absolute text inside the `<time>`, or an
  accessible description. Adding a tab stop to every timestamp is not one.

## Done when

Dimmed xs text measures at least 4.5:1 on every editor background, and a screen reader reads a
timestamp's absolute date.
