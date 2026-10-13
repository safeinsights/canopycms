---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. After a save comes back `WRITE_OUTCOME_UNKNOWN`, the editor holds that entry's saves until it is re-read. If the entry is then deleted or renamed, the re-read fails, so the hold never lifts and the user never reaches the `ENTRY_GONE` handling (follow the rename, or "Save as new entry"). Nothing is stored wrongly; the user is stuck behind the "may already have gone through" toast
---

# A save hold on an entry that is since deleted never lifts

## What is known

- The hold is `reloadRequiredRef` in `packages/canopycms/src/editor/hooks/useDraftManager.ts`:
  `handleSave` returns early while the held token still matches, and only a successful
  `performReload` releases it.
- `performReload` reads by path, so a deleted or renamed entry fails to load ("Reload failed").
- The `ENTRY_GONE` path in `handleSave` (follow a rename by content ID, else offer "Save as new
  entry") is the recovery, but the hold returns before any request is sent.
- Related: [reload-keeps-draft.md](reload-keeps-draft.md).

## Done when

A failed reload of a held entry that is no longer at its path releases the hold into the
`ENTRY_GONE` handling, or the hold is checked against the server some other way.
