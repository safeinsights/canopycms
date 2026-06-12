# Entry navigator scales to a hard 10,000-entry ceiling

## Problem

The editor loads the entire entry list up front. `refreshEntries` calls
`listAllEntries` (`packages/canopycms/src/editor/hooks/useEntryManager.ts`), which
pages through the `entries.list` endpoint at 200/page up to a safety cap of
`MAX_ENTRY_PAGES = 50` — i.e. 10,000 entries. Beyond that the navigator stops, shows a
yellow "Showing the first 10,000 entries" notification, and the remaining entries are
simply not loaded into the tree (not browsable or selectable there).

It does **not** crash — it degrades gracefully — but the ceiling is hard, with no
in-product way to reach entries past it.

A second-order detail: the default refresh lists in collection-traversal order (each
collection's entries, ordered then alphabetical), so the entries that get dropped at the
cap are those in the *last-traversed* collections, not an arbitrary slice.

## Why it's deferred

Acceptable for the first production sites. The adopter that surfaced the pagination bug
(docs-site-proto) has ~50 entries per collection; 10,000 is ~200× headroom. No current
deployment is near the ceiling.

## Cost of the current approach

Each full refresh re-runs the entire server-side listing plus per-path access-control
checks for every page, so a refresh is roughly O(pages × entries). Negligible at current
scale; grows with total entry count.

## Direction when this matters

Move the navigator from "load everything" to **collection-scoped / lazy loading**: fetch
entries per collection as the user expands a node, rather than one flat list of the whole
branch. This both removes the ceiling and bounds per-interaction server cost. The
`entries.list` endpoint already supports a `collection` param and (now) coerced
`limit`/`recursive` query params, so the server side is mostly in place; the work is in
the editor hook and `EntryNavigator`.

A keyset cursor (instead of the current offset cursor) would additionally fix the
inherent offset-pagination skip caveat (an entry deleted mid-pagination shifts the window
and an unrelated entry is skipped). Dedupe-by-`logicalPath` already handles duplicates;
skips are not recoverable with offset cursors.

## Relevant code

- `packages/canopycms/src/editor/hooks/useEntryManager.ts` — `listAllEntries`,
  `refreshEntries`, `ENTRIES_PAGE_LIMIT`, `MAX_ENTRY_PAGES`
- `packages/canopycms/src/api/entries.ts` — `listEntriesHandler`, offset-cursor
  pagination, `maxLimit`
- `packages/canopycms/src/editor/EntryNavigator.tsx` — tree rendering
