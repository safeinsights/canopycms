---
priority: P3
adopters: BOTH
summary: >-
  From the UX review of the batch 2 visual PR: an object field's "Clear" wipes every subfield with no Undo; a date-only value is presented as a midnight date-time; empty menu-section items show a not-allowed cursor; unlabelled schema names show raw; and four guideline gaps need rulings
---
# Object "Clear" Undo, and other UX batch 2 review leftovers

Found by the ux-review round on the batch 2 visual PR (theme contrast, `DestructiveMenuItem`,
compact "Outline"). None was in that PR's scope.

## Code

- **"Clear" has no Undo.** `fields/ObjectField.tsx`'s Clear (`FormRenderer.tsx` `case 'object'`)
  resets the whole object to `undefined` at once, every subfield with it. [Destructive
  actions](../../docs/ux-guidelines.md#destructive-actions) has removals inside a form go at once
  with an Undo toast; route Clear through the list items' removal and Undo path, focus returning
  to the object on Undo. The button is gray because Clear deletes nothing stored; revisit if Undo
  is ruled out.
- **Date-only presentation.** `fields/DateTimeField.tsx` reads `2024-05-01` as local midnight and
  shows "1 May 2024, 00:00:00" with the time-zone note; a pick writes a full UTC timestamp, which
  a site formatting in UTC renders as the previous day east of UTC. A date-only value may want a
  date-only picker and to stay date-only on save.
- **Empty-section cursor.** `components/ReasonedMenuItem.tsx` gives every blocked item a
  `not-allowed` cursor, including EditorHeader's "No recently modified entries", which is
  information rather than a blocked action.
- **Compact "Outline" tooltip.** `FormHeader.tsx` keeps the Tooltip mounted (`disabled` when the
  pane is wide) so the button keeps focus across the width change; if the pane widens while it is
  open, the button keeps a stale `aria-describedby` until blur, and when compact the name is
  announced twice (name and description).
- **MDX popups have no edge** in dark mode where they open over a `--canopy-surface-subtle` panel
  (`fields/MarkdownField.tsx`); a border or Mantine's dropdown shadow would separate them.
- **Required asterisk** is `--mantine-color-error` (red.6 on white 3.28:1, red.8 on dark.7 3.44:1);
  the theme sets `--canopy-danger-text` but not the error colour (EntryCreateModal,
  RenameEntryModal, CollectionEditor, the new-branch form).
- **Validation errors not linked**: in the FormRenderer "with validation errors" story the Title
  input has `aria-invalid="false"` and no `aria-describedby` pointing at its error text.
- **Raw schema names**: an unlabelled block field shows "blocks" in the outline and "headline",
  "body" as labels in the block story fixture; `entryTypeLabel`-style humanising would cover them.

## Guideline gaps (rulings needed)

- Placeholders have a 4.5:1 floor but no rule keeping them distinct from entered text; the theme
  now holds them at 4.5:1 from the text colour in light mode.
- Focus-ring and focused-border contrast is not among the tokens the guideline lists; dark primary
  shade 5 gives 3.05:1 on dark.5 for the default brand only.
- The ruled dark dimmed colour is about 1.3:1 from body text, so dimmed content (outside-month
  days in the date picker) looks like normal content.
- Whether an empty section inside an otherwise non-empty menu is a reasoned item or plain text.
