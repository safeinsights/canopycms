---
priority: P3
adopters: NEITHER
summary: >-
  docs/ux-guidelines.md is silent on three things PR 538 had to decide: empty states inside a menu (plain text inside role="menu" is skipped by screen-reader arrowing), dark mode in "Colour and contrast" (no ban on fixed palette shades such as gray.0 or dark.7 for text and backgrounds), and how a disabled reason is worded when one wait blocks controls with different verbs.
---

# Guideline gaps: menu empty states, dark mode, shared disabled reasons

Raised by PR 538's UX review. Each is a ruling for JP, then one line in
[docs/ux-guidelines.md](../../docs/ux-guidelines.md).

- **Empty state inside a menu.** PR 538 renders the header menus' "No recently modified entries"
  and "No edited entries yet" as dimmed `Text` in the dropdown. Sighted users see it, but
  screen-reader users arrowing through `role="menu"` skip it. Options: a `Menu.Label`, an
  `aria-disabled` item with the reason, or text plus `aria-describedby` on the trigger.
- **Dark mode.** "Colour and contrast" sets ratios but says nothing about colour schemes,
  though the editor takes a `colorScheme` prop. Rule: text and backgrounds use scheme-aware
  tokens (`--mantine-color-text`, `--mantine-color-default-hover`, `light-dark(...)`), never a
  fixed shade. See [editor-surface-colour-tokens.md](editor-surface-colour-tokens.md).
- **Shared disabled reasons.** "Disabled says why" doesn't say whether the reason uses the
  control's own verb, or how to word one reason that blocks controls with different verbs,
  like CommentsPanel's jump buttons blocked by any in-flight comment write.

## Done when

Each gap has a ruling recorded in the guidelines, and the code matches it.
