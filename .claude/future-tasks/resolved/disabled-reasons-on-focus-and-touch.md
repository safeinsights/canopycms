---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED: Save, Submit for review / Withdraw from review and System health's Purge stay focusable with `aria-disabled` and open their reason on hover, focus and touch; disabled menu items (Move up/down, header reload and discard, a collection's last entry type) use the shared `ReasonedMenuItem`, which shows the reason inline.
---

# Disabled reasons on focus and touch across the editor

The rules are in [docs/ux-guidelines.md](../../../docs/ux-guidelines.md#disabled-controls).
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
