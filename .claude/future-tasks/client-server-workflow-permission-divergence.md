# Client permission model grants the branch creator unconditionally; the server requires general branch access first

## Priority: P3

Found 2026-08-13 state-space-mapping the composed diff for the review-followups
epic. Pre-existing -- none of #205/#209/#210 touched either half of this -- but
it is reachable end-to-end today.

## Problem

The client's workflow-action permission checks grant the branch **creator**
unconditionally, with no dependency on general branch access:

- `packages/canopycms/src/editor/BranchManager.tsx` ~101-115:
  `userIsCreator = branch.createdBy === user.userId`, then
  `canPerformWorkflowActions = userIsCreator || userInACL || isSystemBranch || userIsAdmin || userIsReviewer`.
- `packages/canopycms/src/editor/components/EditorHeader.tsx` ~537-549: the
  same shape, `userIsCreator = userContext?.userId === branchCreatedBy`, folded
  into `userHasPermission = userIsCreator || userInACL || isSystemBranch || userIsPrivileged`.

The server's `canPerformWorkflowAction`
(`packages/canopycms/src/authorization/branch.ts` ~79-91) checks general branch
access FIRST and returns `false` immediately if it fails, before creator status
is even considered:

```ts
const accessResult = checkBranchAccessWithDefault(context, user, defaultAccess)
if (!accessResult.allowed) {
  return false
}
// ...only then does creator/ACL/system-branch/privileged get checked
```

Under `defaultBranchAccess: 'deny'` -- the package default; the example app
overrides it to `'allow'` -- the creator of a branch with no ACL (the create
form sends none) sees an enabled Submit/Withdraw button on both surfaces
(BranchManager and EditorHeader), clicks it, and gets a 403 from the server. The
client and server have silently diverged on what "creator" means: the client
treats creator-ownership as sufficient on its own, the server treats it as one
of several grants that only matters after general access already passed.

## Open question

Which side is right?

- Should the server honor creator-ownership independently of
  `defaultBranchAccess` (i.e. move the creator check ahead of the general-access
  gate, matching what the client already assumes)? This is the more permissive
  reading and changes server authorization behavior for any adopter running
  `defaultBranchAccess: 'deny'`.
- Or should the client stop granting on creator alone, and instead mirror the
  server's actual precedence (general access first, creator as one of several
  grants after)? This is the more conservative fix -- it only touches
  UI-affordance code -- but it means a branch's own creator can be denied
  workflow actions on their own branch under `'deny'` with no ACL, which may
  itself be surprising product behavior worth a second opinion.

Either fix needs a decision from JP before implementation; this file exists to
record the finding and the fork in the road, not to pick a side.

## Related

- `packages/canopycms/src/authorization/branch.ts` -- `canPerformWorkflowAction`,
  `checkBranchAccessWithDefault`
- `packages/canopycms/src/editor/BranchManager.tsx` -- client mirror #1
- `packages/canopycms/src/editor/components/EditorHeader.tsx` -- client mirror #2
