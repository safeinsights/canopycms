---
priority: P3
adopters: BOTH
summary: >-
  From the UX review of the batch 2 visual PR: an object field's "Clear" wipes every subfield with no Undo; a date-only value is presented as a midnight date-time; empty menu-section items show a not-allowed cursor; and unlabelled schema names show raw
---
# Object "Clear" Undo, and other UX batch 2 review leftovers

Found by the ux-review round on the batch 2 visual PR (theme contrast, `DestructiveMenuItem`,
compact "Outline"). None was in that PR's scope.

## Code

- **"Clear" has no Undo.** `fields/ObjectField.tsx`'s Clear (`FormRenderer.tsx` `case 'object'`)
  resets the whole object to `undefined` at once. Route it through the list items' removal and
  Undo path, focus returning to the object on Undo
  ([Destructive actions](../../docs/ux-guidelines.md#destructive-actions)).
- **Date-only presentation.** `fields/DateTimeField.tsx` reads `2024-05-01` as local midnight and
  shows "1 May 2024, 00:00:00" with the time-zone note; a pick writes a full UTC timestamp, which
  a site formatting in UTC renders as the previous day east of UTC. A date-only value may want a
  date-only picker and to stay date-only on save.
- **Empty-section cursor.** `components/ReasonedMenuItem.tsx` gives every blocked item a
  `not-allowed` cursor, including EditorHeader's "No recently modified entries". An empty section
  of a non-empty menu is plain, non-interactive text
  ([Disabled controls](../../docs/ux-guidelines.md#disabled-controls)).
- **Compact "Outline" tooltip.** `FormHeader.tsx` keeps the Tooltip mounted (`disabled` when the
  pane is wide) so the button keeps focus across the width change; if the pane widens while it is
  open, the button keeps a stale `aria-describedby` until blur, and when compact the name is
  announced twice (name and description).
- **Required asterisk** is `--mantine-color-error` (red.6 on white 3.28:1, red.8 on dark.7 3.44:1);
  the theme sets `--canopy-danger-text` but not the error colour (EntryCreateModal,
  RenameEntryModal, CollectionEditor, the new-branch form).
- **Validation errors not linked**: in the FormRenderer "with validation errors" story the Title
  input has `aria-invalid="false"` and no `aria-describedby` pointing at its error text.
- **Raw schema names**: an unlabelled block field shows "blocks" in the outline and "headline",
  "body" as labels in the block story fixture; `entryTypeLabel`-style humanising would cover them.
