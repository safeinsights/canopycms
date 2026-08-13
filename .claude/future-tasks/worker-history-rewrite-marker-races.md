# The history-rewrite marker has three race/retry gaps that can wedge a branch with a false diagnosis

Found by the adversarial review of PR #198
([program-b-final-review-followups.md](resolved/program-b-final-review-followups.md),
HIGH #1, resolved 2026-08-12), which introduced the marker. The reviewer found
no path where #198 destroys committed work — the lease discipline holds — but
three ways the branch can end up **wedged and misdiagnosed**: the exact failure
shape #198 exists to remove, recreated in rarer forms. Rated fix-before-production.

Background: `BranchMetadata.historyRewrittenFrom` records the commit the
worker's rebase replaced. It keys the `--force-with-lease` on both hops
(clone→`remote.git`, `remote.git`→GitHub) and is the sole trigger for
`reconcilePendingRewrite`'s self-heal. See ARCHITECTURE.md "Publishing a
Rewritten History".

The shared root cause of #1 and #2: the marker is a **check-then-act across two
independently-locked metadata saves**, while the task loop and `syncGit` run
concurrently by design (`scheduleLoop`). Each save is individually safe; the
sequence spanning them is not.

---

## MEDIUM-HIGH #1 — a concurrent clear disarms a new episode and disables its own self-heal

Set-once re-read (`markHistoryRewritten`), the clear (`clearHistoryRewrittenMarker`)
and the arming path in `rebaseActiveBranches` have no atomicity between them.

Interleaving:

1. Episode 1's push task is in flight, marker = `X`, GitHub still at `X`.
2. A second rebase completes `R1 → R2`. Arming sees marker `X` still set and
   correctly leaves it (set-once).
3. `forcePublishToLocalRemote` moves `remote.git` to `R2`.
4. The in-flight task lands its push of `R1` and **clears the marker**.
5. The arming path's freshly enqueued task finds **no marker**, so it plain-pushes
   `R2` over GitHub-at-`R1`. `R1` is not an ancestor of `R2`, so: non-fast-forward
   → `PermanentTaskError` reading "Something else moved it on GitHub" — false, we
   did — and with the marker gone `reconcilePendingRewrite` never runs again.

**Permanently wedged, with a diagnosis pointing at an innocent third party.**

**Reviewer's suggested hardening:** after a successful `forcePublishToLocalRemote`
in the arming path, re-read the marker; if it vanished mid-arming, write
`publishedSha` (`R1`). GitHub is then provably at `R1` or `X`, and either lease
converges.

---

## MEDIUM #2 — a stale marker surviving a failed clear wedges the *next* episode

The clear is best-effort (a lock-contention or EFS failure is logged, not
retried), and it is also skipped when `outgoingSha` reads null.

With marker `C0` stale and the base advancing in the same sync cycle that first
revisits it, the heal task cannot run before that same `syncGit` call's rebase
publishes `R2`. The queued task then leases `C0` against GitHub-at-`R1` → stale
info → plain-push fallback of `R2` over `R1` → non-fast-forward →
`PermanentTaskError`, marker still set → straight into #3's treadmill.

This is what the corrected doc comment on `clearHistoryRewrittenMarker` now
warns about: a failed clear destroys nothing, but it is not harmless.

---

## MEDIUM #3 — a wedged branch enqueues one permanently-failing task per cycle, forever

`enqueueGitHubPush` dedupes against `pending/` and `processing/` only, while
`reconcilePendingRewrite` runs every cycle for as long as a marker is set. A
marker-kept wedge — including the deliberate "kept for a human-reconciled retry"
case pinned by #198's own test — therefore produces roughly **288 failed tasks
per day per branch** at the 5-minute default. Each one costs a GitHub round trip
and an `updateBranchMetadataOnFailure` → `invalidateRegistry` (O(branches) EFS
reads), capped only by the 30-day cleanup (~8.6k task files steady-state), and
shows up in the admin Tasks tab as an endless wall of identical failures.

The per-cycle re-enqueue was a deliberate choice in #198 — deduping on the marker
instead starves the GitHub hop whenever a task is lost — but the
permanently-failed case was not considered.

---

## LOW

- The `rewritten` bucket in `reconcileTrackedBranches` can mask a genuine
  cross-deployment collision on a marked branch. The signal is deferred, not
  lost (the next push surfaces it), but the whole point of splitting the bucket
  was to keep the collision warning meaningful.
- `reconcilePendingRewrite`'s `publishedSha === null` arm warns every cycle
  forever and never clears the marker for a branch whose ref vanished from
  `remote.git`.
- The 409 text in `api/branch-status.ts` says the divergence "often clears on
  its own within a few minutes". It does not clear at all for the
  reviewer-fixup path, which deliberately never self-heals, and "a few minutes"
  understates the 5-minute default sync interval.
- The [SYNC-M3] settings-branch wording reads a **pruned** tracking ref as
  "never pushed to GitHub" — a settings branch deleted upstream would be
  reported as a local-only misconfiguration.

---

## Design answers (from #198's author, to the reviewer's open questions)

**Q: Is once-per-cycle-forever the intended retry semantics for a marker-kept
wedge, or should it back off?** It should back off — the current behavior is an
oversight, not a decision. The per-cycle re-enqueue was chosen deliberately over
a marker-based skip (which starves the hop when a task is lost), but a
*permanently failed* task is a third state neither option handles. The fix
should reuse the precedent already in this file: `recordRebaseFailure`'s
`RECORD_REFRESH_MS` throttle exists for exactly this write-amplification concern
(registry regeneration per save). Suggested shape: extend `enqueueGitHubPush`'s
dedupe to also consider a recent permanently-failed task for the same branch,
with backoff capped at roughly hourly.

**Q: Should `reconcilePendingRewrite` clear the marker when the branch is gone
from `remote.git`?** Yes, and log once rather than every cycle. The marker's
only purpose is to key a lease for publishing `remote.git`'s content onward; if
that ref is gone there is nothing to publish and no lease to key, so keeping it
buys nothing and costs a permanent per-cycle warn plus a permanent entry in the
`rewritten` bucket that masks real signal (LOW #1 above). A branch that later
reappears re-arms through the normal path. One caveat: clear only when the
branch *workspace* still exists — if the whole directory is gone the metadata is
moot anyway.

**Q: The `clearHistoryRewrittenMarker` doc comment claiming a guarantee the code
does not have.** Fixed in #198 itself; the comment now states that a failed
clear destroys nothing but can wedge the next episode, and points here.

---

## Fix direction

#1 and #2 are the same root cause and should be fixed together: make the
marker's check-then-act safe across the two saves, either via the reviewer's
re-read-after-publish hardening or by moving the arming sequence under a single
hold of the branch.json lock (note `withOccFileLock` is **not** reentrant and
`save()` takes it internally — see the repair-metadata row in
[../../docs/concurrency.md](../../docs/concurrency.md) for the deadlock this
already caused once).

#3 is independent and can land on its own.

Any fix needs the same red-first discipline #198 used: these are interleavings,
so the tests must drive the two paths against each other rather than asserting
the plumbing back to itself.
