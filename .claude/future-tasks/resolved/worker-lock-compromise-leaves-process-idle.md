---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED (2026-10-09). `CmsWorker.selfStopped` settles once the worker stops itself after a lock compromise, never for a requested stop. Before settling, the drain retakes the lock (waiting out its staleness) and records `lastFatalError` (phase `run`) and `lastShutdown`; a worker that took the lock over owns the file and nothing is written. The entrypoint exits 69 (`EXIT_WORKER_SELF_STOPPED`) so systemd restarts it
---
# [P2] A compromised worker lock leaves a live process doing nothing

**Found:** 2026-10-09, reviewing the shutdown path for request 95.

## Problem

`CmsWorker.acquireLock`'s `onCompromised` handler (packages/canopycms/src/worker/cms-worker.ts)
logs, drops the lock and calls `stop()`, which drains and clears every loop. Nothing then exits.
`canopycms-cdk/worker/index.ts` exits only on SIGTERM, SIGINT or the termination watch. So the
process idles, `Restart=always` never fires, and System health shows the worker absent (the lock
mtime goes stale) with no fatal error recorded.

A compromise means the heartbeat could not be refreshed (an EFS hiccup) or another worker took the
lock. In the first case a restart is exactly right. In the second, a restart finds the lock held
and exits cleanly.

## Fix sketch

Expose a promise or callback on `CmsWorker` that settles when the worker stops for a reason it
chose itself (a compromise). The entrypoint exits non-zero on it, so systemd restarts the worker.
Record `lastFatalError` (phase `run`) so System health says why.
