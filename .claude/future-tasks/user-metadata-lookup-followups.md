---
priority: P3
adopters: BOTH
summary: >-
  Two small gaps in the per-process user-metadata cache: submit's editor attribution still calls `authPlugin.getUserMetadata` once per editor, uncached and unbatched, and two concurrent lookups for the same uncached id in one process both reach the provider
---
# [P3] User-metadata lookup follow-ups

**Priority: P3 [BOTH].** `auth/user-metadata-lookup.ts` caches and batches user lookups for the
`/users/:userId` and `/users/batch` endpoints. Two gaps remain, neither a load problem today:

1. **Submit's editor attribution bypasses it.** `api/branch-status.ts` passes
   `lookupEditor: (id) => authPlugin.getUserMetadata(id)` to `submitBranch`, one provider call per
   editor on every submit. Resolving the editors with one `lookupUsersMetadata` call before
   `submitBranch`, or giving `lookupEditor` a batch shape, would cache and batch them. Submits are
   rare and editors few, so this is consistency more than cost. Keep the attribution fallback in
   `submission-attribution.ts` intact: an unknown editor still records the bare id.
2. **No in-flight sharing.** Two requests in one Lambda that miss the cache for the same id both
   call the provider; the cache only helps after the first answer lands. Storing the pending
   promise per id (dropped on rejection, so a failure is not cached) would collapse them. Only
   worth it if Clerk rate limits show up in logs.
