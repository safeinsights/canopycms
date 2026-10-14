---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 547's and PR 548's UX reviews. docs/ux-guidelines.md is silent on hiding versus disabling a control a path rule refuses, badge text transform, tooltip-only reasons for screen readers, the "All entries"/"Content" naming, and three things PR 547's review hit: Undo for a removal inside a modal (a toast's Undo is outside the focus trap), avatar-only people with no image (no `alt` renders), and whether a close button disabled while busy needs a reason
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

## From PR 548's UX review

- **Hide or disable for path-permission refusals.** "Hide a control that can never apply for this
  user" was written for role-gated items. A non-admin whose path rules refuse new entries now
  meets a navigator with no "…" menus and nothing saying why, though an admin can grant the
  access, which reads more like "Disabled says why". Rule which applies; a collection-level line
  ("You can't add entries here") is one option.
- **Badge text transform.** Mantine's `Badge` uppercases its label ("1 MEMBER", "UNSAVED
  CHANGES", the banner's "PROTECTED"); `UserBadge` turns that off. The sentence-case rule is silent
  on badges.
- **Tooltip reasons for screen readers.** A disabled control's reason Tooltip reaches screen
  readers through floating-ui's `aria-describedby`, while `SyncFailedBadge` also adds hidden text.
  Rule whether the Tooltip alone is enough, so components stop doing it both ways.
- **"All entries" opens "Content".** The header menu item and the breadcrumb root say "All
  entries"; the drawer they open is titled "Content". One word per idea.
