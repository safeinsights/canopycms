---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-14, UX batch 3 theme PR) — the theme's stylesheet in `editor/theme.tsx` gives an unchecked, enabled Switch track's border `--canopy-input-border`, 3.29:1 on its gray.2 track and 4.09:1 on dark.6
---

# Switch track contrast

`fields/ToggleField.tsx` renders Mantine's `Switch`. Its off-state track and border measured
1.30:1 on white in PR 548's UX review, below the 3:1 that docs/ux-guidelines.md (Colour and
contrast) sets for control borders. The "On"/"Off" text beside a read-only toggle carries its
state, but the control's boundary still fails, for editable toggles too.

## Fix

In `editor/theme.tsx`, give `Switch`'s track (off state) the `--canopy-input-border` token the
theme already measures at 3:1, then re-measure on every surface a toggle sits on.
