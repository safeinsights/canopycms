---
priority: P3
adopters: BOTH
summary: >-
  Code only: the guideline gaps from WS7a-1's UX review are now rules in docs/ux-guidelines.md. Left: `openConfirm`'s modal close button has no accessible name.
---
# Confirm modal close button has no accessible name

`openConfirm`'s modal (`packages/canopycms/src/editor/utils/confirm-modal.ts`) renders its close
button with no accessible name. Pass `closeButtonProps: { 'aria-label': 'Close' }` there so every
confirm gets it.
