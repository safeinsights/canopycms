---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED (2026-10-11): GET /:branch/comments returns `users` (id, name, avatar, no email) for the people in the threads the requester can read, the editor seeds the user-metadata cache from it, and every editor sees names on comment surfaces. Step 3 (branch owners) split to branch-owner-names-for-editors.md
---
# Comment author names for editors

## Status: RESOLVED 2026-10-11

Plan steps 1 and 2 shipped on `feat/comment-author-names`. Step 3 is a scope question for JP,
filed as [branch-owner-names-for-editors.md](../branch-owner-names-for-editors.md).

**Decision (JP, 2026-10-10):** the comments API returns each author's display name and avatar,
with no email, for threads the requester can read. It is a follow-up chip after the launch
prerelease, not part of WS3b.

## Why

The editor resolves user ids to names through `apiClient.permissions.getUserMetadata` and
`batchGetUserMetadata` (`hooks/user-metadata-batcher.ts`). Both routes are guarded `privileged`
(`api/permissions.ts`), which admits admins and reviewers only. `Editor.tsx`'s
`canResolveUserNames` therefore hands the resolver to the comment surfaces only for privileged
users, and an editor sees every comment author, branch owner and resolver as a raw id. Bot ids
already show as "CanopyCMS bot" (`editor/user-display.ts`) without a lookup.

## Plan

1. The comments API resolves the author of each returned thread and comment, and the
   `resolvedBy` user, to `{ name, avatarUrl }`. It returns only threads the requester can
   already read, so no directory is exposed, and it carries no email.
2. Seed the user-metadata SWR cache (`canopy:user:<id>`, `hooks/useUserMetadata.ts`) from that
   payload, so `UserBadge` shows the names without a lookup and needs no change.
3. Branch owners in the branch list still need a lookup. Return the owner's name the same way
   from the branches API, or leave owners as ids for editors.
