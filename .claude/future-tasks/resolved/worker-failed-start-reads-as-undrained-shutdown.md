---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED: `readCarriedOverStatus` leaves a snapshot alone when its own worker recorded a startup failure (`lastFatalError.phase === 'startup'` with `workerStartedAt` equal to the file's `startedAt`), so the carried `lastShutdown` keeps describing the last worker that ran. System health shows that shutdown and a separate "Last start failed at" line
---
# A failed start erases the last real shutdown record

**Priority:** P3 (misleading System health text, no data loss). **Found:** 2026-10-09, while
adding `recordWorkerStartupFailure` for the worker-down observability work.

## What happens

`readCarriedOverStatus` (`packages/canopycms/src/task-queue/worker-status.ts`) treats a
`lastShutdown` whose `workerStartedAt` differs from the file's own `startedAt` as belonging to an
earlier worker, and synthesizes `{ reason: 'stopped without draining', outcome: 'not-drained' }`
for the file's own worker. A worker that fails at startup (in `CmsWorker.startUnderLock`'s catch,
or through `recordWorkerStartupFailure` before `start()`) writes a snapshot with its own
`startedAt` and the carried `lastShutdown` of the worker before it. The next worker then reports
the failed one as "stopped without draining (a crash or a forced stop)", and the real record of
how the last healthy worker stopped (for example a drained `SIGTERM`) is gone after one failed boot.

## Options

- A failed start records its own `lastShutdown` (a new outcome such as `failed-start`), so the
  carry-over keeps it rather than synthesizing a crash.
- Or the carry-over leaves a snapshot whose `lastFatalError.phase === 'startup'` alone, keeping its
  carried `lastShutdown` as the previous worker's.

Either way, `SystemHealthPanel`'s shutdown line needs plain wording for the new case.
