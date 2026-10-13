---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. A save refused because the entry was deleted (`ENTRY_GONE`) is shown in a sticky corner toast with "Save as new entry", not in a notice above the entry's form, though it is one entry's lasting state. Once the toast is dismissed nothing on the form says the entry is gone, and the next content-list refresh closes the form and drops its draft from view. The "may already have gone through" hold has the same gap
---

# A deleted entry's state lives in a toast, not above its form

## What is known

- `showEntryGone` in `packages/canopycms/src/editor/hooks/useDraftManager.ts` shows the toast; its
  "Save as new entry" action calls `useEntryManager.recreateEntry`.
- docs/ux-guidelines.md, "Choosing a surface": one entry's lasting state belongs in a notice above
  its form, as `ReadOnlyDraftNotice` does through `FormRenderer`'s `notice` slot.
- The gone entry is selected by path. Any `refreshEntries()` (a create, rename or delete anywhere,
  a schema change, re-auth revalidation) drops it from `entriesState`, the selection falls back to
  the first entry, and `dirtyIds` stops counting its draft, so the branch-switch guard no longer
  protects it. Related: [draft-orphaned-by-contentid-swap.md](draft-orphaned-by-contentid-swap.md).
- `showSaveMayHaveLanded` (the `WRITE_OUTCOME_UNKNOWN` hold) is the same shape: a sticky toast for a
  lasting per-entry state.

## Done when

A deleted entry with unsaved changes stays selectable until the user saves it as a new entry or
discards it, with a notice above its form offering both, and Save says why it cannot save there.
