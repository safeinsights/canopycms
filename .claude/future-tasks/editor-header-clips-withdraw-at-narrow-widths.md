---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from PR 532's UX review. At 390px the editor header's right-hand group overlaps the centre group and clips "Withdraw from review". Fold the fix into the unsaved-indicator and shell redesign
---
# Editor header clips "Withdraw from review" at 390px

`EditorHeader.tsx` lays its site title, entry/branch controls and the Save plus workflow buttons
in one row. At a 390px viewport the fixed-width unsaved indicator (`w={112}`), Save and the
workflow button overflow, so the workflow button's label is clipped and the groups overlap.

This belongs with the shell redesign tracked in
[ux-guidelines-entry-state-and-save-indicator.md](ux-guidelines-entry-state-and-save-indicator.md),
which already makes the indicator icon-only below `lg`. Check it fixes the overlap at 390px; if
not, wrap the right group, or move the workflow button into the "…" menu on narrow widths.
Verify with a Storybook screenshot at the mobile viewport.
