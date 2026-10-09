---
priority: P3
adopters: BOTH
summary: >-
  `listCollectionEntries` (content-listing.ts) stats each file after `readdir` with no guard, so a file another editor deletes or renames (or the worker's rebase moves) between the two makes the whole listing throw ENOENT. `readEntryData` already treats a vanished file as empty. Callers then surface it as their own failure: the delete guard reports "could not check references" and the entries API fails the listing. Fix: treat ENOENT at `stat` as a skipped entry
---
# Listing throws when a file vanishes mid-scan

`listCollectionEntries` reads a directory, then for each file runs `fs.stat` and `readEntryData`
in parallel. `readEntryData` swallows ENOENT; `fs.stat` does not. A concurrent delete, rename or
rebase between `readdir` and `stat` therefore fails the whole listing, for any caller.

The delete guard for referenced entries (`api/entries.ts`, `findReferencedBy`) catches this and
answers "Could not check which entries reference this one; try again" rather than letting the
handler's not-found mapping report the delete target as missing. A retry succeeds.

**Fix:** catch ENOENT from `fs.stat` in `listCollectionEntries` and return `null` for that file,
as an unparseable filename does. Test with a stat that rejects for one file.
