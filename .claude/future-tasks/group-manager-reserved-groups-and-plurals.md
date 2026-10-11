---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3b UX review. The group manager offers Delete on the built-in Admins and Reviewers groups (which the server re-derives), shows "1 MEMBERS", and discards staged changes without confirming
---
# Group manager: reserved groups, plurals, Discard Changes

- **Reserved groups.** `group-manager/GroupCard.tsx` shows the trash icon on Admins and
  Reviewers. `api/groups.ts` re-derives the reserved groups on read, so the Delete group
  confirm's "Its 1 member loses the access it grants" is likely untrue. Disable the icon on
  reserved groups, with the tooltip "Built-in group; it can't be deleted."
- **Plurals.** The member count badge reads "1 MEMBERS". docs/ux-guidelines.md asks plurals to
  agree.
- **Discard Changes** throws away staged group edits without a confirm, unlike Discard changes
  for drafts.
