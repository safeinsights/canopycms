---
priority: P3
adopters: BOTH
summary: >-
  Two small costs in the user-name seeding that GET /branches and GET /:branch/comments feed. (1) `seedUserProfiles` (`editor/hooks/useUserMetadata.ts`) revalidates any record without an email, so for an admin or reviewer a user whose provider record has `email: ''` is refetched through `/users/batch` on every branch-list poll (`IN_FLIGHT_POLL_MS`). (2) Bot-like ids that `isSystemUserId` doesn't cover ('canopycms-ai', '__static_deploy__', the 'unknown' default) are sent to the provider on every listing and come back unknown.
---

# Seeded user records refetch per poll; some bot ids reach the provider

## What is known

- `seedUserProfiles` uses `revalidate: (merged) => !merged?.email` to recover an email a seed
  overtook. A privileged viewer whose user has no email at all keeps triggering that refetch;
  SWR does not dedupe it, since `startRevalidate` clears the in-flight fetch first.
- `lookupUserProfiles` (`auth/user-metadata-lookup.ts`) skips `isSystemUserId` ids and the
  anonymous user. `ai/resolve-branch.ts` and `branch-workspace.ts` create branch workspaces
  under other bot ids, and the branch schema defaults `createdBy` to 'unknown'. Nothing leaks:
  the provider answers unknown and they are dropped.

## Done when

A seeded record is refetched at most once after a privileged lookup has answered (e.g. mark seeded
records and clear the mark on a lookup), and every id CanopyCMS itself writes as a creator is
either covered by `isSystemUserId` or skipped by the lookup.
