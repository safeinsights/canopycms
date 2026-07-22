# Investigate flaky concurrent tests in comment-store.test.ts

## Status: RESOLVED (2026-07-21, epic PR #114)

Root cause confirmed: CommentStore was OCC-only with no in-process lock — concurrent
mutators raced on the shared `loadedVersion` instance state and on rename-vs-verify,
storming into conflicts. Fixed by the layered locking in the EFS concurrency epic
([efs-cross-process-concurrency.md](efs-cross-process-concurrency.md)): withLock
(in-process FIFO) + withOccFileLock (cross-host proper-lockfile) + OCC as defense.
All three `{ retry: 1 }` workarounds removed; the suite passed 20/20 consecutive runs.

Original description below.

---

## Problem

The two concurrent tests (`handles concurrent resolveThread calls` and `handles concurrent deleteThread calls`) are flaky and currently have `{ retry: 1 }` as a workaround. Root cause is likely filesystem timing in concurrent file writes.

## Files

- `packages/canopycms/src/comment-store.test.ts` (lines ~357, ~389)

## Suggested approach

Investigate whether the underlying `CommentStore` has a race condition in concurrent writes, or whether the test assertions need to account for non-deterministic ordering.
