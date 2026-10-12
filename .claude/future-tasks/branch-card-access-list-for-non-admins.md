---
priority: P3
adopters: BOTH
summary: >-
  For an editor who isn't an admin or reviewer, a branch card's access list is mostly identical "Name unavailable" avatars: the server never seeds names for a branch's ACL users, by design. Decide whether non-privileged viewers see a count, the resolvable names only, or no list. Meanwhile `toBranchListItem` still sends them the ACL's user ids.
---

# Branch card access list for non-privileged viewers

`packages/canopycms/src/editor/BranchManager.tsx` renders each access user through `UserBadge`
with the owner line's lookup. For non-privileged viewers that lookup is the seeded resolver, and
the server keeps ACL users behind the privileged lookup, so an access user falls back to
"Name unavailable" unless they also own a listed branch or wrote a loaded comment. Before PR 532 the list showed raw ids, which the People rule forbids.

Raised by the round-2 review of PR 532.

## Options

- Show a count ("Shared with 3 people") to non-privileged viewers.
- Show only the names the viewer can already resolve, plus "and N others".
- Hide the list for them.

## Related: the ACL ids still reach non-privileged callers

`toBranchListItem` in `packages/canopycms/src/api/branch.ts` spreads `...branch`, so every
listed branch's `access.allowedUsers` (and `allowedGroups`) ids go to every caller who can see
the branch, privileged or not. The names stay behind the privileged lookup, but the ids don't.
Whatever the ruling above, strip or reduce `access` for non-privileged callers in the same
change, so the wire matches what the card shows.

## Done when

A ruling is recorded in docs/ux-guidelines.md (People) and the card follows it. Non-privileged callers no longer receive `access.allowedUsers` ids.
