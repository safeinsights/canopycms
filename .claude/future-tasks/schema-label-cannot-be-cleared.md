---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-12. Collection management can't clear an optional value: clearing a collection's label, or an entry type's label or max items, sends `undefined`, which JSON drops and the schema store skips, so the stored value stays. The dialog now shows the stored value, but the edit silently does nothing. Admin-only
---
# Clearing a collection or entry-type label does nothing

`schema-editor/CollectionEditor.tsx` and `EntryTypeEditor.tsx` build their updates with
`label: formData.label || undefined` (and `maxItems: undefined` when the field is emptied).
`undefined` never reaches the server: JSON serialisation drops it, and
`schema/schema-store.ts` applies a field only when `updates.<field> !== undefined`. So an
admin who clears a label or max items sees the dialog accept it, but the stored value stays.

`CollectionEditor` mirrors this in its local entry-type list (it skips undefined fields when
it patches a row), so the list is honest about what is stored. The edit itself still fails silently.

Fix: let the update inputs carry an explicit clear, such as `null` in the zod schemas for
`UpdateCollectionInput` and `UpdateEntryTypeInput`, with the store deleting the key on
`null`, and have both dialogs send `null` for a cleared optional field. Add store and dialog
tests for clearing each optional field.
