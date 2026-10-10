---
priority: P3
adopters: BOTH
summary: >-
  The opt-in duplicate-ID scan (`GET /admin/branch-health?duplicates=1`) spends one 20 s budget across healthy branches in `readdir` order, so on a deployment big enough to truncate, the same tail of branches is reported `unknown` on every check and never gets scanned. A scan cut off at the deadline also keeps reading in the background, since a readdir cannot be cancelled
---

# [P3] A truncated duplicate-ID scan never reaches the same tail of branches

`scanBranchHealth` (`packages/canopycms/src/branch-health.ts`) scans healthy branches in turn
under one shared deadline (`DUPLICATE_ID_SCAN_BUDGET_MS` in
`packages/canopycms/src/api/admin-branch-health.ts`). The order is `fs.readdir`'s, which is stable
on one filesystem, so when the budget runs out it runs out on the same branches every time. System
health honestly shows them as "IDs not checked", but **Check again** cannot reach them.

The branch whose scan is still running at the deadline is abandoned, not stopped: its recursive
readdir keeps going until it settles. Within a Lambda that is bounded by the invocation; in dev or a
long-lived server, repeated checks can stack abandoned scans on a slow filesystem.

Nothing is wrong today: truncation needs a content tree and branch count large enough to spend
20 s in readdir. Track it because the live KB site is the first deployment likely to approach it.

## Fix direction

Any of these, smallest first:

- Let `duplicates` name one branch directory (`duplicates=<dirName>`), and have the panel's
  "IDs not checked" badge offer a per-row check. This also makes the post-repair refresh scan one
  branch instead of all of them.
- Rotate the starting branch per request, or scan least-recently-scanned first.
- Thread an `AbortSignal` through `ContentIdIndex.scanDirectory` so an abandoned scan stops at its
  next directory.
