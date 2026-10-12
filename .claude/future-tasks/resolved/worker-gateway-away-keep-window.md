---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-11) in the worker process split's PR 6. The window is measured to when the worker began waiting for the gateway (`isRecentGatewayFatal`'s `now`, canopycms-cdk worker/run.ts), so a health wait that times out keeps the gateway's own cause. Core's `recordWorkerStartupFailure` keeps a record only when it is the file's own failed start, never one a later worker carried forward. The future and malformed `at` rows are in run.test.ts.
---

# [P3] Tighten which recorded cause an unreachable gateway keeps

**Status:** RESOLVED 2026-10-11, in the process split's PR 6 (all three items).

Found in the review of the commit that added `isRecentGatewayFatal`
(`packages/canopycms-cdk/worker/run.ts`), which a split worker passes to core's
`recordWorkerStartupFailure` (`keepRecordedFatal`, `packages/canopycms/src/worker/cms-worker.ts`).
All three are LOW and self-correcting within one gateway cycle or five minutes.

1. **The window cannot cover a health timeout.**
   - The worker that recorded the gateway's fatal error exits first. The next one starts `health()`
     at least `RestartSec` later and waits up to 300 s (`HEALTH_WAIT_MS`,
     `canopycms/src/worker/github-gateway-http.ts`). By the time that wait times out, the record is
     always older than `GATEWAY_AWAY_KEEP_MS` (5 min).
   - The effect: a gateway whose next boot takes over 300 s has its real cause replaced by "did
     not answer health in time".
   - **Fix:** measure the age from when this attempt's `health()` started (pass that as `now`), or
     make the window larger than the health wait plus a restart and a boot.
2. **A carried-forward record still counts.**
   - `startUnderLock` writes its first snapshot carrying the previous `lastFatalError`. A worker
     that passed `health` (the gateway was healthy) and then died before its first sync leaves the
     gateway's old fatal error looking recent.
   - The effect: an unreachable gateway within the window keeps that superseded cause, and the
     not-ready answer reports it as a retry in progress (`current: false`).
   - **Fix:** keep only the file's own failed start, the `failedStart` test `readCarriedOverStatus`
     already computes (`lastFatalError.workerStartedAt === startedAt`).
3. **The `age >= 0` guard is untested.** Add rows with a future `at` and a malformed `at` to
   `run.test.ts`'s `isRecentGatewayFatal` table; both must be `false`.
