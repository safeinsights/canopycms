---
priority: P2
adopters: BOTH
summary: >-
  A field's inline validation error in `FormRenderer.tsx`'s `renderField` is a bare `<Text>` with no id. The input keeps `aria-invalid="false"` and nothing points `aria-describedby` at the message, so a screen reader user who reaches the field (for example from the validation summary's breadcrumb, which focuses it) hears no error. Give the message an id and pass `aria-invalid` plus `aria-describedby` to every field type, or move to Mantine's `error` prop where the field is a Mantine input.
---

# Inline field errors are not tied to their inputs

## What is known

- `FormRenderer.tsx` `renderField` renders `fieldErrors[canopyPath]` as `<Text size="xs" c="red.8" data-testid="field-error-…">` under the field's error boundary. The text has no id.
- No field component receives the error, so none sets `aria-invalid` or adds the message to `aria-describedby`. Mantine inputs already wire their own `description` id there (`FieldDescription.tsx`'s `fieldDescriptionId`); the error id must be added alongside it, not instead.
- The validation summary (`components/ValidationSummary.tsx`) focuses the field from each breadcrumb, which makes the gap reachable in one click.
- `ImageField` already takes `errors` for its parts (`src`, `alt`, `crop`); that pattern can extend to the other fields.

## Done when

Every field type exposes its error to assistive technology: the input (or the group, for fields without one input) has `aria-invalid="true"` and `aria-describedby` includes the error's id, with a test per field type.
