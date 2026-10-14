---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 548's UX review. A Mantine Switch's off-state track and border are 1.30:1 on white, under the 3:1 control-border rule. A read-only toggle is now enabled with `aria-readonly`, so it no longer has the disabled exemption; editable switches fail the same way. Theme-wide: give the Switch track the theme's `--canopy-input-border`
---

# Switch track contrast

`fields/ToggleField.tsx` renders Mantine's `Switch`. Its off-state track and border measured
1.30:1 on white in PR 548's UX review, below the 3:1 that docs/ux-guidelines.md (Colour and
contrast) sets for control borders. The "On"/"Off" text beside a read-only toggle carries its
state, but the control's boundary still fails, for editable toggles too.

## Fix

In `editor/theme.tsx`, give `Switch`'s track (off state) the `--canopy-input-border` token the
theme already measures at 3:1, then re-measure on every surface a toggle sits on.
