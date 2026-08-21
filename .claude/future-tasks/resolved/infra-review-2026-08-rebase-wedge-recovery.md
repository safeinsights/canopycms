# [P1] Two ways a branch clone is left mid-rebase forever, with no recovery path

Found by the 2026-08-20 three-round infrastructure review (round 1), at HEAD
`7881e489`. Both **CONFIRMED**. They share one fix pass: no exit path from
`rebaseActiveBranches` may leave a clone mid-rebase, and the worker must be able
to recover one it finds.

Related but distinct from [worker-history-rewrite-marker-races.md](../worker-history-rewrite-marker-races.md)
(that one is about the rewrite marker; this is about `.git/rebase-merge` state).

## 1. A modify/delete conflict throws out of the resolution loop, skipping every `rebase --abort`

`cms-worker.ts:2394-2397` runs `git checkout --theirs <file>` for every entry in
`st.conflicted`. For a modify/delete conflict where the **branch** side deleted
the file (git status `UD`, "deleted by them" — an editor deleted an entry that a
merged upstream PR modified), `checkout --theirs` exits non-zero ("path … does
not have their version") and simple-git throws.

The throw originates *inside* the round loop's own catch, so it escapes the round
loop entirely, skips both `rebase --abort` sites (`:2418`, `:2435` — unreachable
from this path), and lands in the outer per-branch catch (`:2577-2589`), which
only logs and records `rebaseFailure`. It never aborts the in-flight rebase.

**Scenario.** Editor deletes `content/posts/a.md` on `feature-x`, branch
committed clean. Another PR merges to `main` modifying the same file. Next sync
cycle: worker rebases, git reports `CONFLICT (modify/delete)`,
`st.conflicted = ['content/posts/a.md']`, `checkout --theirs` throws. The clone
is left with `.git/rebase-merge` present and HEAD detached — and any *other*
conflicted file already carries conflict markers in the working tree, which the
Lambda's ContentStore happily serves to editors and lets them save over (the
content-write lock was released in the `finally`). Every later cycle logs
"Skipping feature-x: has uncommitted changes" (`:2268-2273`). The branch never
rebases, never submits cleanly, never self-heals. Recovery requires an operator
running `git rebase --abort` on EFS by hand.

## 2. A rebase interrupted by worker termination is never detected or aborted

If the worker dies while a rebase is between rounds — SIGKILL, OOM on the 512MB
t4g.nano, spot interruption, or **the ASG rolling update that happens on every
`cdk deploy`** — the clone keeps `.git/rebase-merge` on disk. `stop()`
(`:513-530`) drains for at most `taskTimeoutMs` (60s), while a sync cycle across
many branches on EFS can legitimately run far longer.

Nothing anywhere detects a stale in-progress rebase: a repo-wide grep for
`rebase-merge` / `rebase-apply` finds no detection code. The next cycle's dirty
check classifies the branch `skippedDirty` forever, and `branch-health.ts` has no
category for it — the branch scans as **healthy**.

**Scenario.** `cdk deploy` rolls the worker mid-rebase on a branch with several
conflict rounds over slow EFS. systemd SIGTERMs; 60s later the process exits with
the rebase half-applied. The replacement instance recovers orphaned *tasks*
correctly but `feature-y` reports "has uncommitted changes" every cycle from then
on. The docs' claim that "the replacement worker picks up exactly where the old
one left off" does not hold for this state; editors on that branch see a
half-rebased tree and the branch never receives base updates again.

## Fix direction

- Handle the delete side explicitly in the resolution loop: for `UD`/`DU` shapes
  use `git rm` / `git checkout --theirs` per the keep-branch-version policy, and
  treat any per-file resolution failure as "abort this branch's rebase".
- Add a best-effort `rebase --abort` to the outer per-branch catch so no exit
  path can leave a clone mid-rebase.
- At the top of the per-branch loop (inside the content-write lock, before the
  dirty check), detect `.git/rebase-merge` / `.git/rebase-apply` and abort it. An
  interrupted rebase is always this worker's own abandoned work — it is the only
  thing that ever rebases these clones.
- Optionally surface rebase-in-progress as its own `branch-health` category, so
  the state stops scanning as healthy.
