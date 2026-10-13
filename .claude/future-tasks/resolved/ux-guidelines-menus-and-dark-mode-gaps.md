---
priority: P3
adopters: NEITHER
summary: >-
  RESOLVED (2026-10-13) — both EditorHeader empty menu states are blocked `ReasonedMenuItem`s, with tests that arrow keys reach them
---

# Menu empty states are skipped by arrow keys

## Status: RESOLVED 2026-10-13

`components/EditorHeader.tsx` renders "No recently modified entries" and "No edited entries yet"
as dimmed `Text` in the header menus' dropdowns. Screen-reader users arrowing through
`role="menu"` skip it. [Disabled controls](../../../docs/ux-guidelines.md#disabled-controls) rules
an `aria-disabled` item saying why (`ReasonedMenuItem`); render each empty state as one.

Dark-mode surfaces are tracked in [editor-surface-colour-tokens.md](editor-surface-colour-tokens.md).

## Done when

Both empty states are `aria-disabled` menu items, with a test that arrow keys reach them.
