---
priority: P2
summary: >-
  New 2026-10-04, same source. A save carrying a numeric `expectedVersion` whose file is gone skips the version check (`ENOENT` is treated as a first write), so editing an entry another editor deleted (or renamed) silently recreates it, undoing their delete; a delete or rename of the editor's own that got no answer reaches it too. Not content loss, but a version-holding save that isn't checked against disk
---
# A save carrying a version silently recreates an entry another editor deleted

Found 2026-10-04 while re-verifying
[occ-version-key-contentid-swap.md](resolved/occ-version-key-contentid-swap.md).

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
- Read [docs/concurrency.md](../../docs/concurrency.md) before changing the check: it is the
  authoritative OCC gate for entry writes.

## Fix direction

On the API path, a numeric `expectedVersion` that finds no file is a 409 ("this entry was
deleted by another editor"), and the editor offers to recreate it explicitly (a create,
`expectedVersion: null`). Check direct `ContentStore.write` callers first; none passes a
numeric version today outside the API.
