---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED: the theme's `Button` extension draws filled `red` as `red.8` (`red.9` on hover) and filled `orange` as `orange.6` under black text, so callers still pass a plain colour; Undo moves focus to the restored row; example1's Next.js dev badge moved to the bottom-right, away from the toasts.
---
# Filled confirm buttons miss contrast; Undo doesn't move focus

The rules are in [docs/ux-guidelines.md](../../../docs/ux-guidelines.md#colour-and-contrast)
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
