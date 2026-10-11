---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3b UX walk. An editor with no edit access to a collection (path rules or `defaultPathAccess`) is still offered Add Entry, Rename Entry and Delete Entry in the navigator; the server refuses them
---
# Navigator entry actions ignore path edit access

In `apps/example1` (whose `defaultPathAccess` is read-only), User One still sees Add Entry,
Rename Entry and Delete Entry in the content navigator. The server refuses each one, so nothing
is written, but the editor offers actions that can only fail.

Entries carry `canEdit` (`api/entries.ts`) and the form already respects it. Collections carry
no equivalent, so gating Add Entry needs one: a per-collection edit flag from the entries
listing, for example.
