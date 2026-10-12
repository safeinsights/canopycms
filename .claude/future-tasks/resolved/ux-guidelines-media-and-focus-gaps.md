---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED: `openConfirm` passes `closeButtonProps: { 'aria-label': 'Close' }`, merged under the caller's own props, so every confirm modal's close button is named.
---
# Confirm modal close button has no accessible name

`openConfirm`'s modal (`packages/canopycms/src/editor/utils/confirm-modal.ts`) renders its close
button with no accessible name. Pass `closeButtonProps: { 'aria-label': 'Close' }` there so every
confirm gets it.
