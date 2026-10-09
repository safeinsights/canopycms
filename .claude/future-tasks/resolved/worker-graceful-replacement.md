---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/worker-graceful-replacement`, base `int-202610-b` (adopter request 95). `CmsWorker.stop()` drains: no new claims, sync stops at a stage or branch boundary, a 90 s deadline aborts what remains, an aborted task is released to pending with no retry spent and its git push killed, the lock is released last, and `lastShutdown` reaches System health. canopycms-cdk adds a terminating lifecycle hook (`workerTerminationHeartbeat`, default 5 min) that the worker completes after draining, an IMDS termination watch, and `KillMode=mixed` / `TimeoutStopSec=120` / exit 75 on the unit. The about-2-minute gap remains: the handoff is deferred as worker-successor-handoff.md.
---
# [P3] Replacing the worker cuts off in-flight work

**Status: RESOLVED 2026-10-09**, branch `fix/worker-graceful-replacement`. Drain only; see the
summary for what shipped.

**Found:** 2026-10-09, adopter request 95, measured on a test deployment upgrading canopycms-cdk
between two `int` prereleases.

## Problem

Every deploy that changes `WorkerLaunchTemplate` replaces the worker terminate-first (the rolling
update needs `MinInstancesInService: 0`). That is every canopycms bump, since the worker bundle
carries the version. The ASG logged "Terminating" then "Launching" about 10 s later, and the new
worker logged "CMS Worker starting" about 2 minutes after the terminate. A submit made in the gap
was queued and run 13 s after the new worker started.

Nothing drained the old worker:

- The unit had no `KillMode`, so the default `control-group` sent SIGTERM to the `git` children at
  the same instant as node: an in-flight push died whatever `stop()` did.
- `stop()` raced in-flight work against `taskTimeoutMs`, then released the lock and exited, and
  `processTaskQueue` never re-checked `isRunning()`, so a stopping worker kept claiming tasks.
- A cut-off task stayed in `processing/` until orphan recovery's 5-minute floor.
- Nothing told the instance it was terminating before the OS shutdown.

## Decision

Drain only, with a terminating lifecycle hook. Handing off to a successor that is already booting
was deferred: [worker-successor-handoff.md](../worker-successor-handoff.md).
