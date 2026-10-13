---
priority: P3
adopters: BOTH
summary: >-
  Code item for docs/ux-guidelines.md's `--canopy-danger-text` rule: a red Mantine `Menu.Item` draws its text at red.6 (3.3:1 on white), and `c="red.8"` error text fails on gray.0 and in dark mode. Add the per-scheme variable (red.9 light, red.4 dark) and a shared destructive menu item, and move all error text onto it
---
# Destructive menu items and error text fail contrast

## The gap

Mantine 7's `Menu.Item` sets `--menu-item-color` inline from `color`: a bare theme colour becomes
shade 6, so `color="red"` text is red.6 (#fa5252), 3.3:1 on white. Being an inline `__vars`
value, the theme's `vars` resolver cannot override it. `editor/fields/ItemList.tsx` passes
`c="red.8"` on its Remove item; the two `color="red"` items in `editor/EntryNavigator.tsx`
(Delete) still render at red.6.

`red.8` itself is 4.5:1 on white but 4.3:1 on `gray.0` and about 3:1 on the dark menu, which
covers that Remove item, "Has errors" and every `c="red.8"` error text.

## Fix

[docs/ux-guidelines.md](../../docs/ux-guidelines.md#colour-and-contrast) names the rule:

- Add `--canopy-danger-text` to `canopyCssVariablesResolver` (`theme.tsx`): `red.9` light,
  `red.4` dark. Measure it on each surface it sits on (white, `gray.0`, `gray.1`, the red hover
  tint; `dark.5`-`dark.7`) and pin the ratios in `theme.test.tsx`.
- A shared destructive menu item (next to `components/ReasonedMenuItem.tsx`) uses it; switch the
  navigator's Delete items and `ItemList`'s Remove to it.
- Move every `c="red.8"` error text onto the variable.
