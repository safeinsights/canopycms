---
priority: P3
adopters: BOTH
summary: >-
  The `review` path permission level (`PermissionLevel = 'read' | 'edit' | 'review'`) is offered in the Permission Manager but no server code ever checks it, so an admin's `review` rule decides nothing. Either enforce it (comment resolve, approve/request-changes on the paths a branch touches) or remove it from the type and the UI
---

# The `review` path level is configurable but never enforced

`config/types.ts` defines `PermissionLevel = 'read' | 'edit' | 'review'`, and
`editor/permission-manager/constants.tsx` offers all three in the Permission Manager. Every
server-side `createContentAccessChecker` / `checkContentAccess` call passes `'read'` or `'edit'`;
none passes `'review'`. Review actions are gated by the reserved `reviewers` group
(`isReviewer`) instead, branch-wide.

So a rule such as `{ path: 'content/legal/**', review: { allowedGroups: ['legal'] } }` is saved,
shown, and has no effect, which reads to an admin as a working control.

Found while gating comments by path read rules: resolving a comment checks the entry at `read`
plus the thread-author / reviewer rule, and there was no `review`-level precedent to follow.

## Options

1. **Enforce it**: decide which actions it governs (resolving a comment on the entry;
   approving or requesting changes on a branch whose changed paths match), then check it there.
2. **Remove it**: drop `'review'` from `PermissionLevel` and the Permission Manager, leaving
   review to the `reviewers` group.

Either is a product decision for JP. It interacts with
[list-permission-level.md](list-permission-level.md), which proposes the level ordering
`list < read < edit < review`, and with
[authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md).
