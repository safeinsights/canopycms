# [P3] Content-write lock: wait budget is not configurable, granularity is per-branch

Raised by the human review of
[PR #229](https://github.com/safeinsights/canopycms/pull/229#pullrequestreview-4938780868)
(finding #5b), 2026-08-14. Explicitly **not** rated a blocker by the reviewer: "the trade is
the right one." Filed so the trade is a recorded decision rather than something discovered
later under load.

## The two effects

`packages/canopycms/src/utils/content-write-lock.ts`,
`packages/canopycms/src/content-store.ts:164-173`.

1. **Granularity.** In-process serialization used to be per-entry (`entryLockKey` /
   `idLockKey`). The cross-host lock ([SYNC-C1]) is per-branch-root, so **all** writes to one
   branch now serialize behind it, with a 2s ceiling before a 409.

   Bounded on Lambda (one invocation per container; only cross-container writers contend,
   and the critical section is normally a few `fs` calls). It bites hardest where in-process
   concurrency is real: `next dev`, and build-time provisioning across worker processes.

   The case to watch: a write whose in-lock path triggers a full `idIndex()` rescan of a
   large tree over EFS can plausibly exceed 2s and start 409-ing unrelated saves.

2. **`DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS` is a constant.** `contentWriteLockWaitMs` exists as
   a parameter only for tests. There is no way to tune it for a production deployment whose
   EFS latency or content-tree size makes 2s the wrong number.

## Fix direction

- Plumb `contentWriteLockWaitMs` from `CanopyConfig` (defaulting to the current constant) so
  a deployment can raise it without a code change.
- If the rescan case shows up for real, the answer is probably to keep the coarse lock but
  move the `idIndex()` warm-up out of the critical section, not to re-split the lock.

Already done in the PR #229 follow-ups: the constant's doc comment now states that it is the
writer-vs-writer budget as well as the rebase one, and `ContentWriteLockBusyError`'s message
no longer claims a rebase is in progress when another writer is the real cause.
