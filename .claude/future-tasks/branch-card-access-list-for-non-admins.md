---
priority: P3
adopters: BOTH
summary: >-
  For a non-privileged viewer, a branch card's access list is mostly identical "Name unavailable" avatars, and `toBranchListItem` still sends them the ACL's user ids. docs/ux-guidelines.md (People) now rules: show the names the viewer can resolve, then "and N others", and never send `access.allowedUsers` ids to a caller without the privileged lookup
---

# Branch card access list for non-privileged viewers

[People](../../docs/ux-guidelines.md#people) rules the card and the wire.

## The card

`packages/canopycms/src/editor/BranchManager.tsx` renders each access user through `UserBadge`
with the owner line's lookup. For non-privileged viewers that is the seeded resolver, and the
server keeps ACL users behind the privileged lookup, so most fall back to "Name unavailable".
Show only the names that resolve, then "and N others".

## The wire

`toBranchListItem` in `packages/canopycms/src/api/branch.ts` spreads `...branch`, so every
listed branch's `access.allowedUsers` (and `allowedGroups`) ids go to every caller who can see
the branch. Strip or reduce `access` for non-privileged callers in the same change, keeping the
count the card needs.

## Done when

The card follows the rule, and non-privileged callers no longer receive `access.allowedUsers`
ids, each with a test.
