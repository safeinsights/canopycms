---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). `ToggleField` renders a focusable Switch with `aria-readonly` whose `onChange` does nothing when read-only: Tab reaches it, it announces its state, and click or Space leaves the value alone. Its "On" / "Off" text stays, since a read-only switch looks as live as an editable one.
---
# A read-only toggle is disabled, not read-only

## Status: RESOLVED 2026-10-13

`packages/canopycms/src/editor/fields/ToggleField.tsx` passes `disabled={readOnly}` to its
Mantine `Switch`. The Fields rule says a read-only form's inputs are read-only, not disabled.
Found by the UX review of the comments keyboard route (PR 531).

Mantine's `Switch` has no `readOnly` that blocks toggling, so the fix is a focusable Switch whose
`onChange` does nothing when read-only, with `aria-readonly`, or a read-only text rendering of
the value that takes focus.

## Done when

On a read-only form, Tab reaches each toggle, it announces its state and read-only, and Space
does not change it.
