---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED: the theme's `ModalCloseButton` default (`editor/theme.tsx`) names every confirm modal's close button "Close", and the name survives a caller's own `closeButtonProps` unless that sets `aria-label`.
---
# Confirm modal close button has no accessible name

`openConfirm`'s modal (`packages/canopycms/src/editor/utils/confirm-modal.ts`) renders its close
button with no accessible name. Pass `closeButtonProps: { 'aria-label': 'Close' }` there so every
confirm gets it.
