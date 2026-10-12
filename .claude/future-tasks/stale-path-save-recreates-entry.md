---
priority: P2
adopters: BOTH
summary: >-
  `ContentStore.write` (`content-store.ts`) skips its version check when the file is missing and `expectedVersion` is a number ("first write, skip the version check"), so a save from an editor still showing an entry that was since deleted or renamed recreates it at the old path, with a new content ID: references to the old ID dangle and the next submit publishes it. Reachable whenever the editor missed the delete or rename: another editor did it, or the editor's own request timed out or got a gateway 504 after it landed. Refuse a numeric `expectedVersion` on a missing file with `ContentConflictError` ("This entry no longer exists"), after checking which callers send a token for a file that does not exist yet.
---

# A save to a deleted or renamed entry recreates it

## What is known

- The API maps an omitted token to `null` (create) in `api/content.ts`, so a numeric token always
  comes from a read of an existing file; the editor's `saveEntry` refuses to save without one.
- In `ContentStore.write`, `fs.stat` failing with `ENOENT` falls through for both `null` (correct)
  and a number (the stale path), inside the per-entry lock.
- The editor refreshes its content tree after a delete, rename or create that got no answer (a
  timeout or a gateway's 5xx page: `editor/unanswered.ts`), in `useSchemaManager.deleteEntry`,
  `useEntryManager.renameEntry` and `handleCreateModalSubmit`, but an entry left open with a draft
  can still be saved back.
- Read [docs/concurrency.md](../../docs/concurrency.md) before changing the check: it is the
  authoritative OCC gate for entry writes.

## Done when

A save carrying a version for a file that no longer exists gets a 409, and the editor shows it.
