---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. `MemberList` renders a group member as a bare `{userId}` badge when it gets no `onGetUserMetadata`, showing a raw id as person text against docs/ux-guidelines.md's People rule. Use UserBadge's "Name unavailable" fallback (with the id only as admin-surface detail), or make the lookup prop required.
---

# MemberList shows a raw user id when it has no lookup

`packages/canopycms/src/editor/group-manager/MemberList.tsx` has two branches for each group
member. With `onGetUserMetadata` it renders `UserBadge` (`revealIdOnFallback`, so an unresolved
member reads "Name unavailable" with the id as secondary detail). Without it, it renders a plain
`Badge` whose label is the user id itself.

`onGetUserMetadata` is optional at every level (`GroupManagerProps` in `group-manager/types.ts`,
`InternalGroupsTab`, `GroupCard`, `MemberList`), so any caller that omits it reaches the bare-id
branch. Today the only caller, `Editor.tsx`, always passes it, so only stories and tests render it.
The group manager is admin-only, but the People rule still treats an id as an internal name.

## Fix

Either make `onGetUserMetadata` required through the group-manager props (and delete the bare
branch), or render the same "Name unavailable" text the badge fallback uses, keeping the id as
visually secondary admin detail. Check `PermissionEditor.tsx`'s equivalent no-lookup branches for
the same pattern.

## Done when

No group-manager or permission-manager branch renders a user id as the primary label for a person.
