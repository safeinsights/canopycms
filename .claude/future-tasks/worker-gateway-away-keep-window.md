---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from the last review round of the worker process split's PR 5. `isRecentGatewayFatal` (canopycms-cdk/worker/run.ts) decides which recorded `lastFatalError` an unreachable GitHub gateway leaves in place, and has three small gaps. Its 5-minute window can never cover the 300 s health-timeout path. It keeps a record a later worker's `start()` carried forward after the gateway was healthy again. And its future-`at` guard has no test.
---

# [P3] Tighten which recorded cause an unreachable gateway keeps

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
