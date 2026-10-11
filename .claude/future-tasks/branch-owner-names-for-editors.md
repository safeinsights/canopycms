---
priority: P3
adopters: BOTH
summary: >-
  Scope pending JP. Editors see branch owners in the branch list as raw ids, because name lookups take the `privileged` guard. Recommended: GET /branches returns the owner's name and avatar, never email, for the branches the requester can see, using the same pattern as the comments API
---
# Branch owner names for editors

**Status: scope pending JP** (whether to build it in the editor UI epic's phase 2 lite).

Split from [comment-author-names-for-editors.md](resolved/comment-author-names-for-editors.md)
(its step 3). The comments API now returns `users: UserProfile[]` (`auth/types.ts`). The editor
seeds the `canopy:user:` SWR cache from it through `seedUserProfiles` (`hooks/useUserMetadata.ts`),
so every editor sees names on comment surfaces. The branch list (`BranchManager.tsx`) still shows
owners and access users through the privileged `onGetUserMetadata` only.

## Recommended plan

1. `GET /branches` adds `users: UserProfile[]` for the `createdBy` of each branch it returns. These
   are branches the requester may already see, so no directory is exposed. Look them up with
   `lookupUsersMetadata`, whose per-process cache keeps the branch list's polling off the provider
   within its TTL. Skip bot ids (`isSystemUserId`), and build each profile field by field so no
   email can leak.
2. `useBranchesData` seeds the cache from it, and `BranchManager` gets a resolver for owners only.
   Editors' owner badges then name the owner.
3. Leave `access.users` (the branch ACL) on the privileged path, since it is ACL detail rather
   than identity.

Needs an authorization test like `api/comments-users.test.ts`, and a `docs/adopter-migration.md`
entry.
