---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). `onGetUserMetadata` is required through the group manager (`GroupManagerProps`, `InternalGroupsTab`, `GroupCard`, `MemberList`) and the permission manager (`PermissionManagerProps`, `PermissionTree`, `PermissionEditor`, `UserSelector`); `Editor.tsx` always passes it. The bare-id `Badge` branches and the unreachable search-result fallbacks are deleted, so an unresolved person reads "Name unavailable" (id only as admin detail via `revealIdOnFallback`). Group badges show group names, which is not a person label.
---
# MemberList shows a raw user id when it has no lookup

## Status: RESOLVED 2026-10-13

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
