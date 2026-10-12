---
priority: P3
adopters: BOTH
summary: >-
  Bot-like ids that `isSystemUserId` doesn't cover ('canopycms-ai', '__static_deploy__', the 'unknown' default) are sent to the user-metadata provider on every GET /branches and GET /:branch/comments listing and come back unknown.
---

# Some bot ids reach the user-metadata provider

## What is known

- `lookupUserProfiles` (`auth/user-metadata-lookup.ts`) skips `isSystemUserId` ids and the
  anonymous user. `ai/resolve-branch.ts` and `branch-workspace.ts` create branch workspaces
  under other bot ids, and the branch schema defaults `createdBy` to 'unknown'. Nothing leaks:
  the provider answers unknown and they are dropped.

## Done when

Every id CanopyCMS itself writes as a creator is either covered by `isSystemUserId` or skipped by
the lookup.
