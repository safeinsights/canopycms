# [P3] Doc residue left after the baseline-quality epic

**Status:** RESOLVED 2026-09-14 in the bookkeeping PR (#350) of
[baseline-quality-202609.md](baseline-quality-202609.md), from the manager's round-1 review.
Filed the same day from that PR's `docs-architecture` and `docs-developing` runs.

## What was open, and what closed it

- `docs/concurrency.md` narrated past behavior in eight places the marker regex does not match
  ("Its old comment claimed…", "is now a read-modify-write", "Until [SYNC-C1] above…", "was,
  briefly, written down as fact", "Now `write()` refuses first", "once threw out of
  `syncGit()`", "caught in review once already"). Each is restated as the rule or as the failure
  mode it prevents; no rule, bound or error name changed.
- Root `AGENTS.md`'s Code Organization table had no `task-queue/` or `http/` row, and its
  `worker/` row still said "task queue". Both rows are added; the worker row says "task runner".
- Root `AGENTS.md` named `pnpm lint:comments` and `pnpm lint:docs` with no pointer; it now links
  `DEVELOPING.md#comment-and-doc-budgets`.
- `task-queue/README.md` said to call `recoverOrphanedTasks` "on startup". It now says the worker
  calls it at boot and every poll with `orphanRecoveryMaxAgeMs(ctx)`, a threshold derived from
  `taskTimeoutMs`.
