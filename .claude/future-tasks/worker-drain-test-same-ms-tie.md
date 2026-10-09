---
priority: P2
adopters: NEITHER
summary: >-
  `cms-worker-drain.test.ts` "finishes the task it holds and claims no other" flakes in CI. It
  enqueues two tasks back to back, and when both get the same millisecond `createdAt`, the queue
  breaks the tie by random task id, so about half the time the worker claims the second task
  first. Make the test independent of claim order, or give the tasks distinct times
---
# The worker drain test assumes FIFO within one millisecond

**Priority:** P2 (it turns unrelated PRs red). **Found:** 2026-10-09, CI on PR #460, run
37998095269, job "Unit Tests (canopycms 3/3)". It passed 6 of 6 times locally.

## Cause

The test (`packages/canopycms/src/worker/cms-worker-drain.test.ts`, from the worker-drain change)
enqueues `first` and then `second`, and expects the worker to claim `first`. `claimNextTask` sorts
pending tasks by `createdAt`, then by `id` (`task-queue/task-queue.ts`, the `tasks.sort` call).
`createdAt` has millisecond resolution, so on a fast runner the two times tie, and the random UUID
decides the order.

The failure:

```
expected [ "ae6978dc-…" ] to deeply equal [ "3a3a2fe9-…" ]
```

## Fix

Either:

- assert on whichever task was claimed: the claimed task completed and the other is still pending;
- or enqueue the second task with a later `createdAt`, using fake timers or a write that sets it.

The queue's ordering is fine as it is. Only the test's assumption is wrong.
