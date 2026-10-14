---
priority: P3
adopters: BOTH
summary: >-
  UX batch 2 review leftovers: a pick in a date-only value saves a UTC timestamp, a compact "Outline" is announced twice, the required asterisk misses contrast, validation errors aren't linked to their inputs, unlabelled collection and entry-type names show raw, and some states have no story
---
# UX batch 2 review leftovers

Found by the ux-review round on the batch 2 visual PR (theme contrast, `DestructiveMenuItem`,
compact "Outline"). None was in that PR's scope.

## Code

- **Date-only values on save.** `fields/DateTimeField.tsx` reads `2024-05-01` as local midnight,
  as [Fields](../../docs/ux-guidelines.md#fields) rules, but a pick writes a full UTC timestamp,
  which a site formatting in UTC renders as the previous day east of UTC. Whether a date-only
  value keeps its form on save, or wants a date-only picker, is undecided.
- **Compact "Outline" announced twice.** `FormHeader.tsx`'s compact button has the hidden name
  "Outline" and its Tooltip describes it as "Outline" again. Every icon-only control with a
  same-text Tooltip does the same ([Accessibility](../../docs/ux-guidelines.md#accessibility)), so
  a fix belongs to that pattern, not this button.
- **Required asterisk** is `--mantine-color-error` (red.6 on white 3.28:1, red.8 on dark.7 3.44:1);
  the theme sets `--canopy-danger-text` but not the error colour (EntryCreateModal,
  RenameEntryModal, CollectionEditor, the new-branch form). A theme change.
- **Validation errors not linked**: in the FormRenderer "with validation errors" story the Title
  input has `aria-invalid="false"` and no `aria-describedby` pointing at its error text.
  `FormRenderer`'s `renderField` draws the message beneath each field, so every field component
  needs the error's id passed to its input.
- **Raw collection and entry-type names.** Fields, groups and block templates without a label are
  humanised (`schemaLabel` in `editor/schema-label.ts`); an unlabelled collection or entry type
  still shows its raw name (`buildCollectionLabels` in `editor-utils.ts`, `navCollections` and the
  create dialog's `collectionLabel` in `Editor.tsx`, `et.label || et.name` in
  `components/EntryCreateModal.tsx`).
- **Stories.** `admin/SystemHealthPanel.tsx` has none, so its row icons and badges are seen only
  in tests; FormRenderer's `RemovedItemThread` story stubs `removedItemFieldLabel`, so the
  schema-only fallback breadcrumb is never rendered.
- **Toast punctuation.** "Removed "X" from Y" has no full stop until a note follows it
  (`components/UndoToastMessage.tsx`).
