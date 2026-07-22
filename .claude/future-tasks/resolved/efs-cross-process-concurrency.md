# EFS Cross-Process Concurrency (Epic)

## Status: RESOLVED (2026-07-21, epic PRs #111–#116 on integration branch `epic/efs-cross-process-concurrency`)

All four findings fixed with one coordinated design, adversarially reviewed before
implementation. The durable reference is now **[docs/concurrency.md](../../../docs/concurrency.md)**
(layered model, EFS/NFS semantics, per-resource table, residual windows, recipes).

- **PR #111 (primitives):** `resource-generation.ts` generalizes the PR #94 marker
  (must-succeed vs hint bumps, ENOENT-vs-read-error distinction, durable-snapshot
  window-E caveat); `utils/occ-json-write.ts` extracts the shared OCC write +
  `withOccFileLock` (proper-lockfile, server-enforced — the honest cross-host story;
  the originally-proposed 50ms settle demonstrably could NOT fix cross-host races).
- **PR #112 (GIT-M1):** registry snapshots embed the pre-scan marker token; invalidate =
  must-succeed bump + eager regen; get-miss backstop; stale-file scheme retired.
- **PR #113 (GIT-M2):** schema-cache same protocol; combined
  `invalidateBranchContentCaches()` bumps content-index + schema markers at every bulk
  working-tree mutation site (incl. previously-uncovered `cli/migrate`); prod no longer
  needs an mtime walk. Includes the epic's process-boundary integration test.
- **PR #114 (GIT-M3):** comment-store withLock + lockfile + OCC-as-defense; the three
  `{retry:1}` workarounds removed, 20/20 consecutive clean runs — closes
  [flaky-comment-store-tests.md](flaky-comment-store-tests.md).
- **PR #115 (GIT-M4):** branch-metadata adopts the helper with the lockfile (the real
  fix; a settle cannot bridge the 3–60s NFS attr-cache window).
- **PR #116:** content-store rename-invariant content-ID lock keys (readdir-derived,
  NOT index-derived), buildPaths inside the lock, per-slug create keys — closes
  [content-store-lock-key.md](content-store-lock-key.md).

Original epic description below, kept for context.

---

**Priority: P1** — correctness under the go-live AWS shape (Lambda + EC2 worker sharing EFS)
**Origin:** July 2026 baseline review (findings GIT-M1, GIT-M2, GIT-M3, GIT-M4); successor to the resolved cross-process ContentId index staleness work (PRs #91, #94)

## Context

The concurrency model is: in-process per-path mutexes + per-file OCC version tokens, with `proper-lockfile` used only for branch provisioning. PR #94 solved the ContentId index half of the cross-process problem with an on-disk generation marker (`content-index-generation.ts`, `invalidateContentIndexesDurable`). The remaining races below share the same root cause — caches and read-modify-write cycles that two processes (Lambda and worker) can interleave on EFS — and should get one coordinated design rather than four ad-hoc fixes. The generation-marker pattern from #94 is the obvious candidate to generalize.

## Open findings

1. **GIT-M1 — branch-registry regenerate race.** `branch-registry.ts` `regenerate()` takes no lock, so a regeneration that started before an invalidation can finish after it and resurrect a stale snapshot (stale branch listings/status/access labels). Not an authz hole — auth reads branch.json directly — but user-visible staleness.
2. **GIT-M2 — branch-schema-cache regenerate race + no prod mtime backstop.** `branch-schema-cache.ts` has the same regenerate-after-invalidate race, and unlike dev, prod has no mtime check — a stale schema (wrong field set, skipped reference fields) stays pinned until the next explicit invalidation.
3. **GIT-M3 — comment-store has no in-process lock.** `comment-store.ts` relies on OCC alone (unlike branch-metadata's `withLock`); reviewer + editor commenting on the same branch is the expected workflow, so contention is normal-use, not edge-case. This is the root cause of the retry-flagged tests in [flaky-comment-store-tests.md](flaky-comment-store-tests.md) — fixing this closes that task too.
4. **GIT-M4 — branch-metadata write-verify omits the NFS settle.** `branch-metadata.ts` post-write verification reads back immediately; comment-store uses a 50ms settle for NFS caching. On EFS two near-simultaneous renames can each read back their own writeId → silent lost update on branch status/access (Lambda vs worker).

## Related

- [content-store-lock-key.md](content-store-lock-key.md) — lock keys should be content IDs, not physical paths; worth folding into the same design pass.
- Residual NFS-caching windows documented in [index-staleness-multiprocess.md](index-staleness-multiprocess.md) (resolved task, kept for its analysis).

## Suggested direction

Generalize the #94 on-disk generation marker into a small shared primitive (per-resource generation file + settle-aware verify), apply it to both regenerating caches, add `withLock` + settle to comment-store and branch-metadata writes. Verify with the existing concurrent tests un-retried (comment-store) plus a two-process integration test if feasible.
