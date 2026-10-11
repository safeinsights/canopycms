---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3b UX review. Every filled red confirm button (Mantine red.6, white text) measures about 3.3:1, under the 4.5:1 docs/ux-guidelines.md asks for; and the guidelines say toasts go bottom-right while theme.tsx deliberately uses bottom-left, opposite the rail, and say nothing about timers on actionable toasts
---
# Filled confirm buttons miss contrast; toast guidelines need three fixes

1. **Filled buttons.** `openConfirm` (`editor/utils/confirm-modal.ts`) callers pass
   `confirmProps: { color: 'red' }`. White on Mantine's `red.6` measures about 3.3:1, and orange
   about 2.6:1, both below 4.5:1. Either set `autoContrast` in `CanopyCMSProvider`'s theme
   (`editor/theme.tsx`), or have the guideline name a shade that passes, such as `red.8`, and
   apply it everywhere at once.
2. **Toast position.** docs/ux-guidelines.md says "bottom-right, away from the rail", but the
   rail is on the right, so `theme.tsx`'s `position="bottom-left"` follows the intent. Reword
   the guideline to "the corner opposite the rail". This supersedes the bottom-right suggestion
   in [editor-toast-position.md](editor-toast-position.md).
3. **Actionable toasts.** The guidelines don't say how long a toast carrying an action lives.
   Add: it pauses while focused (Mantine pauses on hover only; `UndoToastMessage`'s `onHold`
   is the pattern), and focus goes somewhere sensible after the action. The Undo toast keeps
   focus on the list after Remove, but doesn't yet move focus to the restored row after Undo.
