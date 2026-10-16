---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). The group manager now says "1 member" / "N members" (one `memberCountLabel` for both sites), disables Delete on the built-in Admins and Reviewers groups with a focusable reason (`aria-disabled`, Tooltip "Built-in group; it can't be deleted." on hover, focus and touch), and the save bar's "Discard changes" asks first. The confirm lives in the shared `StagedChangesDrawer`, so the permission manager's save bar asks too.
---
# Group manager: reserved groups, plurals, Discard changes

## Status: RESOLVED 2026-10-13

- **Reserved groups.** `group-manager/GroupCard.tsx` shows the trash icon on Admins and
  Reviewers. `api/groups.ts` re-derives the reserved groups on read, so the Delete group
  confirm's "Its 1 member loses the access it grants" is likely untrue. Disable the icon on
  reserved groups, with the tooltip "Built-in group; it can't be deleted."
- **Plurals.** The member count badge reads "1 MEMBERS". docs/ux-guidelines.md asks plurals to
  agree.
- **Discard changes** in the save bar throws away staged group edits without a confirm (closing
  the drawer does confirm), unlike discarding drafts (`hooks/useDraftManager.ts`).
- **Plural sites.** The count is rendered in `group-manager/InternalGroupsTab.tsx` and
  `group-manager/GroupCard.tsx`; both need the singular at 1.
