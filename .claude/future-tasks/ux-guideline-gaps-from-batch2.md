---
priority: P3
adopters: BOTH
summary: >-
  Code follow-ups to JP's 2026-10-13 rulings on the batch 2 UX gaps, now rules in docs/ux-guidelines.md: hide UserBadge's avatar-only initials from assistive tech, a collection-level line where path rules hide the "…" actions, Badge uppercase off theme-wide, hidden reason text on icon-only disabled controls, and "All entries" renamed "All content"
---

# UX batch 2 gaps: code follow-ups

The rules are in [docs/ux-guidelines.md](../../docs/ux-guidelines.md); each item brings the
editor into line with one.

- **Avatar-only people** ([People](../../docs/ux-guidelines.md#people)). `UserBadge`'s
  `avatar-only` variant leaves Mantine's initials exposed to screen readers: hide them and
  render the person's name as visually hidden text.
- **Path-rule refusals** ([Disabled controls](../../docs/ux-guidelines.md#disabled-controls)). A
  non-admin whose path rules refuse new entries meets a navigator with no "…" menus and nothing
  saying why. Add one collection-level line ("You can't add entries here").
- **Badge case** ([Copy](../../docs/ux-guidelines.md#copy)). Turn off `Badge`'s uppercase in
  `editor/theme.tsx`, then drop `UserBadge`'s local `textTransform: 'none'`.
- **Disabled reasons.** Give icon-only disabled controls their reason as visually hidden text
  too; controls that carry text keep the Tooltip alone.
- **"All content".** Rename the header menu item (`components/EditorHeader.tsx`) and the
  breadcrumb root (`buildBreadcrumbSegments` in `editor-utils.ts`) from "All entries" to "All
  content"; the drawer they open is "Content"
  ([Vocabulary](../../docs/ux-guidelines.md#vocabulary)). The example label in
  `RootCollectionConfig`'s doc comment (`config/types.ts`) says "All entries" too.
