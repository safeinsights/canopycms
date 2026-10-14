---
priority: P3
adopters: BOTH
summary: >-
  UX batch 2 review leftovers: a pick in a date-only value saves a UTC timestamp, a compact "Outline" is announced twice, MDX popups have no edge in dark mode, the required asterisk misses contrast, validation errors aren't linked to their inputs, unlabelled collection names show raw, and no `--canopy-focus-ring` token or non-colour cue for dark dimmed text exists yet
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
- **MDX popups have no edge** in dark mode where they open over a `--canopy-surface-subtle` panel
  (`fields/MarkdownField.tsx`); a border or Mantine's dropdown shadow would separate them.
- **Required asterisk** is `--mantine-color-error` (red.6 on white 3.28:1, red.8 on dark.7 3.44:1);
  the theme sets `--canopy-danger-text` but not the error colour (EntryCreateModal,
  RenameEntryModal, CollectionEditor, the new-branch form). A theme change.
- **Validation errors not linked**: in the FormRenderer "with validation errors" story the Title
  input has `aria-invalid="false"` and no `aria-describedby` pointing at its error text.
  `FormRenderer`'s `renderField` draws the message beneath each field, so every field component
  needs the error's id passed to its input.
- **Raw collection names.** Fields, groups and block templates without a label are humanised
  (`schemaLabel` in `editor/schema-label.ts`); an unlabelled collection still shows its directory
  name (`buildCollectionLabels` in `editor-utils.ts`, `navCollections` in `Editor.tsx`).
- **Focus-ring token.** Add `--canopy-focus-ring`, measured at 3:1 on its surface for any
  adopter brand ([Colour and contrast](../../docs/ux-guidelines.md#colour-and-contrast)); dark
  primary shade 5 gives 3.05:1 on dark.5 for the default brand only.
- **Dark dimmed cue.** Dark dimmed text is about 1.3:1 from body text, so it also needs a size
  or style difference ([Colour and contrast](../../docs/ux-guidelines.md#colour-and-contrast)).
  Sweep every dimmed text in `editor/` that matches its neighbours' size and style, in any form
  (`c="dimmed"`, a computed `'dimmed'`, `var(--mantine-color-dimmed)`), but not icons: about 140
  uses, `components/ReasonedMenuItem.tsx`'s blocked items and the date picker's outside-month days
  among them.
