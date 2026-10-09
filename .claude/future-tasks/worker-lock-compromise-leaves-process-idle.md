---
priority: P2
adopters: BOTH
summary: >-
  When the worker's EFS lock is compromised, `onCompromised` calls `stop()` and the worker stops working, but the process stays alive, so systemd never restarts it. The deployment then has no working worker until someone restarts the service or the instance.
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
