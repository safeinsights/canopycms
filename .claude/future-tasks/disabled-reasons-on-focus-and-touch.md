---
priority: P2
adopters: BOTH
summary: >-
  docs/ux-guidelines.md's Disabled controls section now asks that a disabled control's reason Tooltip open on keyboard focus and touch, and that disabled menu items stay focusable with `aria-disabled`. Only BranchManager's card actions do both; the rest of the editor uses hover-only Tooltips and native `disabled`, starting with EditorHeader's Save.
---

# Disabled reasons on focus and touch across the editor

The rules are in [docs/ux-guidelines.md](../../docs/ux-guidelines.md#disabled-controls).
`packages/canopycms/src/editor/BranchManager.tsx` is the pattern: `events={{ hover: true, focus: true, touch: true }}`
on the Tooltip and `data-disabled` / `aria-disabled` on the Button, so the control stays
focusable. Mantine's Tooltip defaults to hover only.

1. **Save** in `packages/canopycms/src/editor/components/EditorHeader.tsx` uses native `disabled`
   under a hover-only Tooltip, so keyboard users never reach "No changes to save" or the
   read-only reasons.
2. **Menu items** set `disabled` rather than `aria-disabled`: Move up and Move down in
   `packages/canopycms/src/editor/EntryNavigator.tsx`, and the header menu's reload item in
   `EditorHeader.tsx`. Each gets `aria-disabled` and its reason inline, or drops the reason if
   it needs none.
3. Sweep the remaining disabled-with-Tooltip controls under `packages/canopycms/src/editor/`.
