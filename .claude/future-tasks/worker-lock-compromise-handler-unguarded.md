---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09. The worker's own queue lock (`lockWorkerTaskDir` in `worker/cms-worker.ts`) passes its `onCompromised` straight to proper-lockfile, so it is the one lock not wrapped by `guardOnCompromised` (`utils/provisioning-lock.ts`). A throw from its handlers (they log, then call `stop()`) would escape the refresh timer as an uncaught exception. Wrap it and add a test that a throwing handler does not escape
---
# [P3] The worker lock's compromise handler is not guarded

**Found:** 2026-10-09, by the claim-check of `fix/occ-compromise-warn-and-409-messages`.

## Problem

`guardOnCompromised` (`utils/provisioning-lock.ts`) makes "a compromise handler never throws
out of proper-lockfile's refresh timer" structural for the provisioning, content-write and OCC
locks. `lockWorkerTaskDir` (`worker/cms-worker.ts`) calls `lockfile.lock` directly with
`onCompromised: options.onCompromised`, so its three handlers (`recordWorkerStartupFailure`,
`acquireLock`, `recordLockLoss`) are unguarded. They call `workerLogError` and, in
`acquireLock`, `this.stop(...)`; a synchronous throw from either would be an uncaught
exception that kills the worker — and under `CI=true`, vitest turns any console write into a
throw.

The handlers already log through an always-on logger, so there is no observability gap.

## Fix direction

`onCompromised: guardOnCompromised(options.onCompromised, path.join(taskDir, '.worker-lock'))`
in `lockWorkerTaskDir`, plus a test that captures the handler (spy on `lockfile.lock`, as
`utils/occ-json-write.test.ts` does) and asserts a throwing handler does not escape.
