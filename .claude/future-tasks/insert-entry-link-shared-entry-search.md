---
priority: P3
adopters: BOTH
summary: >-
  `InsertEntryLink` (fields/entry-link/) still inlines its own entry filter and
  group-by-collection; switch it to `editor/entry-search.ts`, which the navigator's quick-open
  palette already uses, so the two pickers match on the same fields and group under the same
  headings
---
# InsertEntryLink should use the shared entry search

`packages/canopycms/src/editor/fields/entry-link/InsertEntryLink.tsx` filters entries by
label, slug and collection name, and groups them by `collectionName ?? collectionPath`, in two
inline `useMemo`s. The quick-open palette (`editor/components/QuickOpenPalette.tsx`) does the
same job through `editor/entry-search.ts` (`filterEntries`, `groupEntriesByCollection`).

The two have drifted already:

- InsertEntryLink matches on collection name too; the shared matcher matches label and slug
  only.
- InsertEntryLink headings are collection *names*; the palette uses collection *labels* via a
  lookup.

`fields/` belonged to another chip while the palette landed, so the switch was left out of
that PR.

## Fix

Replace the two memos with the shared helpers. Decide whether collection-name matching
belongs in the shared matcher (then the palette gains it too) or stays out. Pass a collection
label lookup so the headings match the palette. Keep `InsertEntryLink.test.tsx` green, and
add a case for the heading text.
