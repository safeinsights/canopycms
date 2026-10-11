---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS0. Editor surfaces still name literal palette colours (`bg="white"` in Editor.tsx, ThreadCarousel.tsx and InlineCommentThread.tsx, plus many `gray.0`/`gray.1` backgrounds). Fine in light mode, but a dark colour scheme would need theme-level surface tokens instead
---
# Editor surfaces use literal colours

`CanopyCMSProvider` accepts `colorScheme`, but editor surfaces hard-code light palette steps:

- `bg="white"` in `Editor.tsx`, `comments/ThreadCarousel.tsx` and `comments/InlineCommentThread.tsx`;
- `bg="gray.0"` and `var(--mantine-color-gray-1)` panel backgrounds (`ObjectField`, `BlockField`,
  `EditorPanes`).

Before dark mode is supported, introduce surface tokens in `theme.tsx` (Mantine
`virtualColor`, or CSS variables resolved per scheme) and move these call sites onto them.
Out of scope for [ui-epic-202610.md](ui-epic-202610.md) unless dark mode is added.
