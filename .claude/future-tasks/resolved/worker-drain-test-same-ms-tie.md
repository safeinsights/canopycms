---
priority: P2
adopters: NEITHER
summary: >-
  RESOLVED (2026-10-09). `cms-worker-drain.test.ts` "finishes the task it holds and claims no other"
  no longer assumes which task is claimed first. It freezes `Date` while it enqueues both tasks, so
  their `createdAt` always ties and the queue picks by random id. It then asserts that exactly one
  task ran and completed and the other stayed pending. Under the forced tie, the old assertion failed
  in 30 and in 33 of 61 repeats (two measurements) and the new one passed every repeat. No other task-queue or worker test relies on
  same-millisecond FIFO: the ones that check order wait 5 to 10 ms between enqueues
---
# The worker drain test assumes FIFO within one millisecond

## Status: RESOLVED 2026-10-09

**Priority:** P2 (it turns unrelated PRs red). **Found:** 2026-10-09, CI on PR #460, run
37998095269, job "Unit Tests (canopycms 3/3)". It passed 6 of 6 times locally.

## Cause

The test (`packages/canopycms/src/worker/cms-worker-drain.test.ts`, from the worker-drain change)
enqueues `first` and then `second`, and expects the worker to claim `first`. `dequeueTask` sorts
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
