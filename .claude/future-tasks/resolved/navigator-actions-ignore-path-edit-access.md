---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED (2026-10-13). The entries listing now carries `collectionAccess`, one `canAddEntry` per listed collection, probed with a new-entry path no slug can take so only collection-wide rules decide; the navigator offers "Add entry…" only where it is true. Rename and Delete were already hidden for an entry with `canEdit: false` (`EntryNavigator`'s `entryLocked`)
---
# Navigator entry actions ignore path edit access

## Status: RESOLVED 2026-10-13

`api/entries.ts` computes `collectionAccess`; `hooks/useEntriesData.ts` marks `EditorCollection.canAddEntry`; `Editor.tsx`'s `navCollections` gates `onAdd` on it. Tests in `api/entries.test.ts`, `hooks/useEntriesData.test.ts` and `Editor.admin-and-undo.test.tsx`. The server still checks each create.

In `apps/example1` (whose `defaultPathAccess` is read-only), User One still sees Add Entry,
Rename Entry and Delete Entry in the content navigator. The server refuses each one, so nothing
is written, but the editor offers actions that can only fail.

Entries carry `canEdit` (`api/entries.ts`) and the form already respects it. Collections carry
no equivalent, so gating Add Entry needs one: a per-collection edit flag from the entries
listing, for example.
