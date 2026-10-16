---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). Every branch response goes through `toBranchListItem`, which gives a caller without the privileged user lookup only the ACL entries naming them or their groups, plus a `withheldAccess` count; `getStatus` and `updateAccess` go through it too. The branch card's `BranchAccessList` shows the names its lookup resolves, then "and N others"
---

# Branch card access list for non-privileged viewers

## Status: RESOLVED 2026-10-13

`toBranchListItem` (`api/branch.ts`) reduces `access` for non-privileged callers; `api/branch-owners.test.ts` checks the wire carries no withheld id and no email. `editor/components/BranchAccessList.tsx` renders the card's list, tested in `BranchManager.test.tsx`.

[People](../../../docs/ux-guidelines.md#people) rules the card and the wire.

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
