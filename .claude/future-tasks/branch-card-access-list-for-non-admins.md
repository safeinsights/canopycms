---
priority: P3
adopters: BOTH
summary: >-
  For an editor who isn't an admin or reviewer, a branch card's access list is N identical "Name unavailable" avatars: the server never seeds names for a branch's ACL users, by design. Decide whether non-privileged viewers see a count, the resolvable names only, or no list.
---

# Branch card access list for non-privileged viewers

`packages/canopycms/src/editor/BranchManager.tsx` renders each access user through `UserBadge`
with the owner line's lookup. For non-privileged viewers that lookup is the seeded resolver, and
the server keeps ACL users behind the privileged lookup, so every access user falls back to
"Name unavailable". Before PR 532 the list showed raw ids, which the People rule forbids.

Raised by the round-2 review of PR 532.

## Options

- Show a count ("Shared with 3 people") to non-privileged viewers.
- Show only the names the viewer can already resolve, plus "and N others".
- Hide the list for them.

## Done when

A ruling is recorded in docs/ux-guidelines.md (People) and the card follows it.
