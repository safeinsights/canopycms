---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, spotted while fixing PR 532's review findings. Leftovers against the guideline: "All Files" (Title Case, "file") in the entry menu and breadcrumb root; "Draft cleared for file" and a "Reload or Discard this file" toast; unnamed icon-only ActionIcons (CollectionEditor's row menu, and the Remove buttons on MemberList and PermissionEditor's no-lookup badges); the owner line showing a raw id when no lookup is given; two tooltips on a removable UserBadge
---
# Vocabulary and naming leftovers beside PR 532

Found next to code PR 532 changed, left out of it:

- **`All Files`**: the entry menu item (`EditorHeader.tsx`) and the breadcrumb root
  (`editor-utils.ts` `buildBreadcrumbSegments`, plus its tests and e2e). The vocabulary says
  entry, and sentence case: "All entries". It is baselined in `scripts/ux-copy-baseline.json`.
- **"file" toasts**: `useDraftManager.ts` raises "Draft cleared for file" (`apps/test-app/e2e`
  asserts it) and a message that says "Reload or Discard this file". Say "entry".
- **Unnamed icon-only buttons**: the "…" `ActionIcon` in `schema-editor/CollectionEditor.tsx`'s
  entry-type rows, and the Remove `ActionIcon`s in the no-lookup `Badge` fallbacks of
  `group-manager/MemberList.tsx` and `permission-manager/PermissionEditor.tsx` (users and
  groups). Each needs an `aria-label` and a Tooltip with the same text. Those no-lookup badges
  also print the raw id; admin surfaces may, but say so in a comment.
- **Owner line**: `BranchManager.tsx`'s owner line falls back to `userIdLabel(createdBy)`, a raw
  id, when no owner lookup is given. `Editor.tsx` always gives one, so only a host that renders
  `BranchManager` itself sees it.
- **Two tooltips**: hovering a removable `UserBadge`'s X opens both the badge's email tooltip and
  the X's "Remove <name>" tooltip. Suppress the outer one while the pointer is on the X.
