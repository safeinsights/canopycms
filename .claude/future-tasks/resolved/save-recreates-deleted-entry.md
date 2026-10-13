---
priority: P2
summary: >-
  RESOLVED (2026-10-12). A save carrying a numeric `expectedVersion` whose file is gone is refused with `EntryGoneError` (API 409, code `ENTRY_GONE`) inside the write lock, ahead of `mkdir` and the create-only guards, so it never re-creates a deleted entry or a renamed entry's old slug; the API refuses it before its create-only checks too. The editor keeps the changes in the form and says the entry was deleted or moved, pointing to its new name or "Add entry…". Covers an editor's own unanswered delete or rename. Creates (`expectedVersion: null`) are unchanged
---
# A save carrying a version silently recreates an entry another editor deleted

## Status: RESOLVED 2026-10-12

Found 2026-10-04 while re-verifying
[occ-version-key-contentid-swap.md](occ-version-key-contentid-swap.md).

## The problem

`ContentStore.write`'s OCC block treats a numeric `expectedVersion` whose target file is
gone (`ENOENT`) as "first write, skip the version check" and writes the file. So if editor
2 deletes an entry while editor 1 has it open, editor 1's next save brings it back with
no conflict and no message. Editor 2's delete is silently undone.

This is not content loss. Editor 1's content is what lands, and a later create of the
same slug 409s rather than overwriting it. But it breaks the rule that a save holding a
version is checked against what is on disk: a missing file is a change since the read.

## Other routes to it

- A rename recreates the old slug the same way, as a second entry beside the renamed one, with a
  new content ID, so references to the old ID dangle and the next submit publishes it.
- The editor itself can miss its own delete or rename: one that got no answer (a request
  timeout, or a gateway's 5xx page behind CloudFront) may still have landed. The editor reloads
  its content tree after such a delete, rename or create (`editor/unanswered.ts`, in
  `useSchemaManager.deleteEntry`, `useEntryManager.renameEntry` and `handleCreateModalSubmit`),
  but an entry left open with a draft can still be saved back.
- Read [docs/concurrency.md](../../../docs/concurrency.md) before changing the check: it is the
  authoritative OCC gate for entry writes.

## Fix direction

On the API path, a numeric `expectedVersion` that finds no file is a 409 ("this entry was
deleted by another editor"), and the editor offers to recreate it explicitly (a create,
`expectedVersion: null`). Check direct `ContentStore.write` callers first; none passes a
numeric version today outside the API.
