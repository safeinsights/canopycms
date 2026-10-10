---
priority: P3
adopters: BOTH
summary: >-
  Two small gaps around `lookupUsersMetadata`, both reachable only when core calls a plugin directly rather than through canopycms-next's CachingAuthPlugin wrap: submit's editor attribution calls `getUserMetadata` once per editor outside the cache, and two concurrent lookups for the same uncached id in one process both reach the provider
---
# [P3] User-metadata lookup follow-ups

**Priority: P3 [BOTH].** `auth/user-metadata-lookup.ts` caches and batches user lookups for the
`/users/:userId` and `/users/batch` endpoints. Two gaps remain, neither a load problem today.
Both apply only to a plugin core calls directly: canopycms-next wraps any plugin with
`verifyTokenOnly` in `CachingAuthPlugin`, which answers from the file-based auth cache
(`packages/canopycms-next/src/context-wrapper.ts:324`).

1. **Submit's editor attribution bypasses it.** `api/branch-status.ts` passes
   `lookupEditor: (id) => authPlugin.getUserMetadata(id)` to `submitBranch`, one provider call per
   editor on every submit (`api/branch-status.ts:91`). Resolving the editors with one `lookupUsersMetadata` call before
   `submitBranch`, or giving `lookupEditor` a batch shape, would cache and batch them. Submits are
   rare and editors few, so this is consistency more than cost. Keep the attribution fallback in
   `describeEditors` (`submission-attribution.ts:127`) intact: an unknown editor, or a lookup
   that throws, still records the bare id.
2. **No in-flight sharing.** Two requests in one process that miss the cache for the same id both
   call the provider; the cache only helps after the first answer lands. Storing the pending
   promise per id (dropped on rejection, so a failure is not cached) would collapse them. Only
   worth it if Clerk rate limits show up in logs.
