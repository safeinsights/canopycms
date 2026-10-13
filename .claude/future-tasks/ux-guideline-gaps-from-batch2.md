---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 547's UX review. docs/ux-guidelines.md is silent on three things the review hit: Undo for a removal inside a modal (a toast's Undo is outside the focus trap), avatar-only people with no image (no `alt` renders), and whether a close button disabled while busy needs a reason
---

# UX guideline gaps found in batch 2

Each needs a ruling in [docs/ux-guidelines.md](../../docs/ux-guidelines.md), then a sweep.

- **Undo inside a modal.** Destructive actions puts Undo in a toast, but a toast sits outside a
  modal's focus trap. PR 547 put the collection dialog's staged-removal Undo in the dialog's
  status line; rule whether that is the pattern for every dialog.
- **Avatar-only people.** "An avatar beside a name has empty alt" doesn't cover an avatar shown
  alone with no image, where Mantine renders initials and `alt` never applies, so a screen
  reader hears the initials. `UserBadge`'s `avatar-only` variant is the site.
- **Disabled close while busy.** `ConfirmDeleteModal` disables its close button while loading;
  rule whether that needs a reason Tooltip like other disabled controls.
