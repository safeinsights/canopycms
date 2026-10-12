---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED: dimmed text takes the theme's `gray.7` (light) and `dark.1` (dark) via `cssVariablesResolver`, and `RelativeTime` adds the absolute date as visually hidden text inside its `<time>`, with no extra tab stop.
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
