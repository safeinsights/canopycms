# [P3] Doc residue left after the baseline-quality epic

**Status:** Open. Filed 2026-09-14 from the `docs-architecture` and `docs-developing` runs in the
bookkeeping PR of [resolved/baseline-quality-202609.md](resolved/baseline-quality-202609.md).
Each fix is small and was outside that PR's scope.

## `docs/concurrency.md`: history phrasing the marker regex does not catch

`pnpm lint:docs` counts zero markers, but these still narrate past behavior instead of stating
the rule (restate as the rule, or as the failure mode it prevents):

- "Content writes vs. the rebase loop [SYNC-C1]": "Its old comment claimed…", "Content files
  had only the in-process mutex", "is now a read-modify-write", "Until [SYNC-C1] above…".
- "Duplicate content IDs vs. the write path [F1]": "and was, briefly, written down as fact",
  "…returned 200. Now `write()` refuses first".
- Tag legend, `[SYNC-M2]` row: "once threw out of `syncGit()` entirely".
- Recipes: "this bug has been caught in review once already".

## Maps and pointers

- Root `AGENTS.md`'s Code Organization table has no row for `task-queue/` (which has
  `task-queue/README.md`) or `http/`.
- Root `AGENTS.md` names `pnpm lint:comments` and `pnpm lint:docs` without linking
  `DEVELOPING.md#comment-and-doc-budgets`.
- `packages/canopycms/src/task-queue/README.md` says to call `recoverOrphanedTasks` "on startup";
  the worker calls it at startup (`worker/cms-worker.ts`) and on every poll cycle
  (`worker/task-runner.ts`).
