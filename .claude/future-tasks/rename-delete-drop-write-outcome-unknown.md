---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09. Only the save handler sends `WRITE_OUTCOME_UNKNOWN` when the content-write lock is lost mid-write. `renameEntry` (`api/content.ts`) and `deleteEntry` (`api/entries.ts`) pass the `BranchSyncingError` message through but drop its `outcome`, so the editor shows "can't tell whether it was recorded" with no code and keeps a stale entries list; a retry then 404s or collides. Nothing is stored wrongly
---
# [P3] Rename and delete drop `WRITE_OUTCOME_UNKNOWN`

**Found:** 2026-10-09, by round 1 of the review of `fix/occ-compromise-warn-and-409-messages`.

## Problem

`BranchSyncingError` carries the content-write lock's `outcome`. When it is `'unknown'` (the
lock was lost after the mutation ran), the save handler in `api/content.ts` adds
`code: 'WRITE_OUTCOME_UNKNOWN'` and the editor holds further saves until the entry is re-read.

The rename handler (`api/content.ts`, `renameEntry`'s catch) and the delete handler
(`api/entries.ts`, `deleteEntry`'s catch) pass `err.message` through but drop `outcome`. The
editor's rename and delete paths show the text and do not refresh the entries list on error,
so after a rename or delete that actually landed the list is stale until the next refresh, and
a retry fails with a 404 or a slug collision.

The wording is also save-specific ("while your change was saved") although rename and delete
raise it too.

## Fix direction

Add the same `...(err.outcome === 'unknown' ? { code: 'WRITE_OUTCOME_UNKNOWN' } : {})` to both
handlers, and have the editor's rename and delete callers refresh the entries list when they
see that code. Consider a neutral message ("while your change was made").

## Why only P3

No data loss or corruption: the failure is a stale list and a retry that is refused cleanly.
