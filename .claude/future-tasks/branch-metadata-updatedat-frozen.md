# BranchMetadata.updatedAt never advances after creation

Found by the Fable review of PR #144 (2026-07-24), verified against the code.

## Problem

`BranchMetadataFileManager.save()` (branch-metadata.ts ~:188-217) computes a fresh
`now` and puts it in `defaults.updatedAt` — but the merge spread is
`{...defaults, ...existing?.branch, ...incoming.branch}`, so once a `branch.json`
exists, `existing.branch.updatedAt` (the creation timestamp) always wins. The
update type (`BranchMetadataUpdate['branch']` =
`Partial<Omit<BranchMetadata, 'createdAt' | 'updatedAt'>>`) forbids callers from
supplying `updatedAt`, so nothing can ever move it.

Net effect: every branch's `updatedAt` equals its `createdAt` forever, despite
status transitions, PR writebacks, conflict-state changes, and the new
`pullRequestState`/`mergedAt` writes all flowing through `save()`.

## Impact

- The editor's Branches panel surfaces `updatedAt` in `BranchSummary` — it's
  always the creation time, silently misleading.
- Any future sorting/staleness logic ("recently active branches") would be built
  on a dead field.

## Fix sketch

In `save()`'s merge, stamp `updatedAt: now` AFTER the spreads (alongside the
`createdBy`/`createdAt` immutability overrides), so every successful save
advances it. Consider whether pure no-op-guard paths (which skip `save()`
entirely) are already the only intended exception — they are, no change needed
there. Add a test: save() advances updatedAt; createdAt untouched.

Relates to [[post-merge-sync-gaps]] (the review that found it).
