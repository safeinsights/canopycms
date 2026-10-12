---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. A red Mantine `Menu.Item` draws its text at red.6 (3.3:1 on white) whatever shade is passed; the navigator's Delete items fail contrast, and the UX guidelines name no rule for destructive menu text or for picker buttons' ellipsis
---
# Destructive menu items fail text contrast

## Priority: P3 [BOTH]

Found 2026-10-12 by the UX review of the collapsible lists and blocks PR.

## The gap

Mantine 7's `Menu.Item` sets `--menu-item-color` inline from `color`: a bare theme colour becomes
shade 6, so `color="red"` text is red.6 (#fa5252), 3.3:1 on white, below the 4.5:1 in
`docs/ux-guidelines.md`. Being an inline `__vars` value, the theme's `vars` resolver cannot
override it. `editor/fields/ItemList.tsx` passes `c="red.8"` on its Remove item; the two
`color="red"` items in `editor/EntryNavigator.tsx` (Delete) still render at red.6.

## Fix

Give every destructive menu item red.8 text in one place, such as a shared `DangerMenuItem` next
to `components/ReasonedMenuItem.tsx`, and use it in the navigator and `ItemList`.

## Guideline gaps to settle in `docs/ux-guidelines.md`

- **Destructive menu text:** "Colour and contrast" names only filled destructive buttons.
- **Ellipsis on a menu button:** "…" marks a command that asks for more input. Whether a button
  that only opens a menu of choices ("Add section") takes one is unstated; the usual convention is
  no.
- **Item actions on a read-only form:** "Disabled says why" against hiding a list row's handle
  and menu when the whole form is read-only, which follows the one-notice rule.
