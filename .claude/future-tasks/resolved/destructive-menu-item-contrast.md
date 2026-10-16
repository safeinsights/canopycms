---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13) — `--canopy-danger-text` (red.9 light, red.3 dark) is set in the theme with its ratios pinned in `theme.test.tsx`; `components/DestructiveMenuItem.tsx` draws the navigator's Delete items, ItemList's Remove, the Branches "Delete branch" item and the entry-type Remove with it, and every red error text uses the variable
---
# Destructive menu items and error text fail contrast

## Status: RESOLVED 2026-10-13

## The gap

Mantine 7's `Menu.Item` sets `--menu-item-color` inline from `color`: a bare theme colour becomes
shade 6, so `color="red"` text is red.6 (#fa5252), 3.3:1 on white. Being an inline `__vars`
value, the theme's `vars` resolver cannot override it. `editor/fields/ItemList.tsx` passes
`c="red.8"` on its Remove item; the two `color="red"` items in `editor/EntryNavigator.tsx`
(Delete) still render at red.6.

`red.8` itself is 4.5:1 on white but 4.3:1 on `gray.0` and about 3:1 on the dark menu, which
covers that Remove item, "Has errors" and every `c="red.8"` error text.

## Fix

[docs/ux-guidelines.md](../../../docs/ux-guidelines.md#colour-and-contrast) names the rule:

- Add `--canopy-danger-text` to `canopyCssVariablesResolver` (`theme.tsx`): `red.9` light,
  `red.3` dark. Measure it on each surface it sits on (white, `gray.0`, `gray.1`, the light red
  hover tint; `dark.4`-`dark.7` and the dark red hover tint, where `red.4` is 4.3:1 and 3.8:1)
  and pin the ratios in `theme.test.tsx`.
- A shared destructive menu item (next to `components/ReasonedMenuItem.tsx`) uses it; switch the
  navigator's Delete items and `ItemList`'s Remove to it.
- Move every `c="red.8"` error text onto the variable.
