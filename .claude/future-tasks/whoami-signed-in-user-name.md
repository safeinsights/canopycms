---
priority: P3
adopters: BOTH
summary: >-
  The signed-in user's own name: `GET /whoami` returns `userId` and `groups` (and `build` for an admin), no name, so the editor can't seed their profile into the `canopy:user:` cache, and their own comment is an unnamed fallback when the comments response's lookup failed. The server's `AuthenticatedUser` has optional `name`, `email` and `avatarUrl`; whoami would have to return them.
---
# Name the signed-in user from whoami

Left over from the UX review of the comment-author-names work (`feat/comment-author-names`).
`UserBadge` now shows "Name unavailable" or "Couldn't load this name" instead of a raw id, and
reads an admin's email as visually hidden text; this is the part that needed an API change.

A comment by the signed-in user needs the comments response (or a privileged lookup) to be named.
When that lookup failed, they see their own comment as an unnamed fallback. `useUserContext`
knows the current user, but `GET /whoami` (`packages/canopycms/src/api/user.ts`) returns
`userId` and `groups` (and `build` for an admin), no name, so there is no name to put in the cache.

Fix: return `name` (and `avatarUrl`; `email` only if the response may carry it) from whoami when
the auth plugin supplies them, then call `seedUserProfiles`
(`packages/canopycms/src/editor/hooks/useUserMetadata.ts`) with the current user's profile once
`useUserContext` resolves. A new response field is a public API addition, so it needs approval
first.
