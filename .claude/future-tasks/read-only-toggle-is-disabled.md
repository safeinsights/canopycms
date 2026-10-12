---
priority: P3
adopters: BOTH
summary: >-
  On a read-only form, ToggleField renders its Switch `disabled`, where docs/ux-guidelines.md (Fields) asks for read-only inputs, not disabled ones. A disabled Switch takes no focus, so a keyboard reviewer cannot reach the field; the "Field comments" menu covers commenting on it, but the value itself is unfocusable.
---

# A read-only toggle is disabled, not read-only

`packages/canopycms/src/editor/fields/ToggleField.tsx` passes `disabled={readOnly}` to its
Mantine `Switch`. The Fields rule says a read-only form's inputs are read-only, not disabled.
Found by the UX review of the comments keyboard route (PR 531).

Mantine's `Switch` has no `readOnly` that blocks toggling, so the fix is a focusable Switch whose
`onChange` does nothing when read-only, with `aria-readonly`, or a read-only text rendering of
the value that takes focus.

## Done when

On a read-only form, Tab reaches each toggle, it announces its state and read-only, and Space
does not change it.
