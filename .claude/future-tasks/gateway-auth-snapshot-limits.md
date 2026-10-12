---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from the worker process split's PR 5 review. The GitHub gateway's `authSnapshot` (the Clerk users, groups and memberships the split worker writes to the auth cache) has two limits. A failed fetch has no backoff, so the next call starts a whole fetch again. And a snapshot past the socket's 64 MiB answer bound (roughly 100k users) is refused, so split mode never refreshes that auth cache.
---

# [P3] The gateway's auth snapshot: no backoff after a failure, and a 64 MiB ceiling

Found reviewing PR 5 of the worker process split (`worker-shared-repo-git-process-split.md`,
§8 "Carried from 5"). `authSnapshot` is in `packages/canopycms/src/worker/github-gateway.ts`;
the Clerk fetch is `fetchClerkSnapshot` in `packages/canopycms-auth-clerk/src/cache-writer.ts`.

1. **No backoff after a failed fetch.**
   - Today: a fetch is single-flight, and a success is answered again for 60 s
     (`AUTH_SNAPSHOT_REUSE_MS`). A failure is never reused.
   - The cost: a worker asking in a loop while Clerk fails part way (the org list 5xx after N user
     pages) repeats the user pagination each time, one fetch at a time.
   - **Fix:** after a failure, answer that failure again for a short backoff, growing with
     repeated failures. Keep the 401/403 key re-read (`canopycms-cdk/worker/clerk-refresh.ts`)
     unchanged.
2. **A snapshot over 64 MiB is refused.**
   - Today: every JSON answer over the socket is bounded by `MAX_JSON_ANSWER_BYTES`
     (`github-gateway-wire.ts`, 64 MiB). The `authSnapshot` schema allows up to a million users, but
     the byte bound bites first, at roughly 100k users.
   - The effect: past it, the worker's auth-cache refresh fails every time, and membership changes
     never reach the cache. Single-process mode has no such bound.
   - **Fix:** stream the snapshot (as bundles are), or give `authSnapshot` its own larger bound, and
     test it at the size the bound names.
