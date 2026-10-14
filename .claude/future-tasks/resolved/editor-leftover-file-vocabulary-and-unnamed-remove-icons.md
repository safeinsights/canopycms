---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). "All Files" is "All entries" (menu item and breadcrumb root); the discard toast reads `Draft cleared for "<entry>"` and the older-draft confirm says "entry" and quotes "Reload entry" / "Discard changes"; the group Remove button in `PermissionEditor` has an `aria-label` and Tooltip (the no-lookup user badges are gone, see member-list-raw-id-without-lookup; `CollectionEditor`'s row menu already had both); the branch owner line reads "Name unavailable" with no lookup; a removable `UserBadge` opens only the X's tooltip while the pointer or focus is on it; and the Title Case labels (Manage permissions, Manage groups, Internal/External groups, Create group, Edit group, Group name, Add member) are sentence case, with the ux-copy baseline re-recorded.
---
# Vocabulary and naming leftovers beside PR 532

## Status: RESOLVED 2026-10-13

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
  also print the raw id as visible text, which the People rule forbids even on admin surfaces.
- **Owner line**: `BranchManager.tsx`'s owner line falls back to `userIdLabel(createdBy)`, a raw
  id, when no owner lookup is given. `Editor.tsx` always gives one, and `BranchManager` is not exported,
  so only tests render it without one.
- **Two tooltips**: hovering a removable `UserBadge`'s X opens both the badge's email tooltip and
  the X's "Remove <name>" tooltip. Suppress the outer one while the pointer is on the X.
- **Title Case labels**: the rail Settings menu's "Manage Permissions" and "Manage Groups"
  (`components/EditorSidebar.tsx`), and the group manager's "Internal Groups" / "External
  Groups" tabs (`group-manager/index.tsx`), "Create Group" (`InternalGroupsTab.tsx`,
  `GroupForm.tsx`), "Edit Group" (`GroupForm.tsx`) and "Add Member" (`MemberList.tsx`). The Copy rule is
  sentence case. These are baselined in `scripts/ux-copy-baseline.json`, so re-record it with
  `node scripts/check-ux-copy.mjs --write-baseline` in the same change.
