---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3b. Comment authors show as raw user ids to editors, because the name lookups (`/users/:id`, `/users/batch`) take the `privileged` guard; the editor now sends them only for admins and reviewers. Proposed: the comments API returns each author's display name and avatar for threads the requester can already read (no directory, no email). Needs JP's ruling
---
# Comment author names for editors

The editor resolves user ids to names through `apiClient.permissions.getUserMetadata` and
`batchGetUserMetadata` (`hooks/user-metadata-batcher.ts`). Both routes are guarded `privileged`
(`api/permissions.ts`), which admits admins and reviewers only. `Editor.tsx`'s
`canResolveUserNames` therefore hands the resolver to the comment surfaces only for privileged
users, and an editor sees every comment author, branch owner and resolver as a raw id. Bot ids
already show as "CanopyCMS bot" (`editor/user-display.ts`) without a lookup.

## Options

1. **Recommended:** the comments API resolves the author, and the resolver, of each thread it
   returns to `{ name, avatarUrl }`. It returns only threads the requester can already read, so
   no directory is exposed, and it carries no email.
2. Let any authenticated user call `/users/batch` for ids that appear on a branch they can read.
   This is broader, and needs a per-id access check.

Either way, the user-metadata cache keyed `canopy:user:<id>` in `hooks/useUserMetadata.ts` can
be seeded from the comments payload, so UserBadge needs no change.
