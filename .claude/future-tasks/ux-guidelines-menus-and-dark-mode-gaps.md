---
priority: P3
adopters: NEITHER
summary: >-
  The header menus' empty states ("No recently modified entries", "No edited entries yet") are dimmed Text inside role="menu", which screen-reader arrowing skips. docs/ux-guidelines.md now rules an aria-disabled item stating why
---

# Menu empty states are skipped by arrow keys

`components/EditorHeader.tsx` renders "No recently modified entries" and "No edited entries yet"
as dimmed `Text` in the header menus' dropdowns. Screen-reader users arrowing through
`role="menu"` skip it. [Disabled controls](../../docs/ux-guidelines.md#disabled-controls) rules
an `aria-disabled` item saying why (`ReasonedMenuItem`); render each empty state as one.

Dark-mode surfaces are tracked in [editor-surface-colour-tokens.md](editor-surface-colour-tokens.md).

## Done when

Both empty states are `aria-disabled` menu items, with a test that arrow keys reach them.
