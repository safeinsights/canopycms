# Block templates' `description` is rendered nowhere

## Priority: P3 [BOTH]

Found 2026-10-05 by the review of the fix that renders `description` for every field type.

## The gap

`BlockConfig.description` (`config/types.ts`) is public API on `defineBlockTemplate`, but
`BlockField.tsx` maps only `name` and `label` into the "Add block" picker and shows only the
template label on each block card. An adopter's template guidance never reaches editors, the same
silent drop that field `description` had.

## Fix

Show it where an editor chooses and edits a block: as the picker option's secondary text (Mantine
`Select` `renderOption`), and under the template label on each card using
`editor/fields/FieldDescription.tsx`, with the card's `aria-describedby` pointing at it. Add a
`FormRenderer.test.tsx` case under `field descriptions`, and drop the "A block template's
`description` still does not render" sentence from `docs/adopter-migration.md`.
