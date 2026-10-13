---
priority: P3
adopters: BOTH
summary: >-
  From the UX review of the batch 2 visual PR: an object field's "Clear" wipes every subfield with no Undo; a date-only value is presented as a midnight date-time; empty menu-section items show a not-allowed cursor; the header's "All Files" item is Title Case and says "file"; unlabelled schema names show raw; and four guideline gaps need rulings
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
- **"All Files"** in `components/EditorHeader.tsx`'s entry menu is Title Case and says "file" for
  entries ([Vocabulary](../../docs/ux-guidelines.md#vocabulary)).
- **Raw schema names**: an unlabelled block field shows "blocks" in the outline and "headline",
  "body" as labels in the block story fixture; `entryTypeLabel`-style humanising would cover them.

## Guideline gaps (rulings needed)

- Placeholders have a 4.5:1 floor but no rule keeping them distinct from entered text; the theme
  now holds them at 4.5:1 from the text colour in light mode.
- Focus-ring and focused-border contrast is not among the tokens the guideline lists; the theme
  sets dark `--mantine-primary-color-filled` to 3:1 on dark.5.
- The ruled dark dimmed colour is about 1.3:1 from body text, so dimmed content (outside-month
  days in the date picker) looks like normal content.
- Whether an empty section inside an otherwise non-empty menu is a reasoned item or plain text.
