---
priority: P2
adopters: BOTH
summary: >-
  Code only: docs/ux-guidelines.md now names `red.8` for filled destructive buttons and `orange.6` with black text for filled warning buttons, and has Undo move focus to the restored row. Callers still pass `color: 'red'` and `color: 'orange'` (white on `red.6` is 3.3:1), the Undo toast leaves focus on the list, and example1's Next.js dev badge covers toasts.
---
# Filled confirm buttons miss contrast; Undo doesn't move focus

The rules are in [docs/ux-guidelines.md](../../docs/ux-guidelines.md#colour-and-contrast)
(Colour and contrast, Destructive actions).

1. **Filled buttons.** `openConfirm` (`packages/canopycms/src/editor/utils/confirm-modal.ts`)
   callers pass `confirmProps: { color: 'red' }` or `{ color: 'orange' }`. White on `red.6` measures 3.28:1 and on `orange.6` 2.57:1.
   Use `red.8` (4.51:1) for red, and `orange.6` with black text (8.17:1) for orange, since no
   orange shade reaches 4.5:1 under white. Apply it in one place, such as `openConfirm` or the
   theme, rather than at each caller.
2. **Focus after Undo.** The Undo toast keeps focus on the list after Remove but doesn't move
   it to the restored row after Undo.
3. **example1's dev badge.** In `apps/example1`'s `/edit`, the Next.js dev badge sits
   bottom-left, over the toasts. Move it (`devIndicators` in example1's Next config).
