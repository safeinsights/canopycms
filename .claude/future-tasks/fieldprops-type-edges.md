---
priority: P3
adopters: BOTH
summary: >-
  Known edges of the typed `FieldProps<T>` (`editor/field-props.ts`) and the preview's inexact-mark warning, accepted when they shipped: the type recognises references, images and block items by shape, refuses a digit-string tuple segment the runtime accepts, is not assignable to a plain function type, and a marks report already in flight when the editor posts a newer draft can log one stale warning
---
# Typed `FieldProps` edges and a stale-warning race

## Priority: P3 [BOTH]

All found in review and judged LOW. None accepts a wrong path the editor would not flag.

- **Shape heuristics.** `IsLeaf` and `ListItem` in `packages/canopycms/src/editor/field-props.ts`
  recognise a value by shape, not by schema. An object field whose children are exactly
  `id`/`slug`/`collection`/`urlPath` is typed as a resolved reference, and one shaped
  `{ src, alt }` as an image, so paths below either are refused though the form has them. An object
  list whose items are exactly `{ template, value }` is typed as a block list: `['items', 0, 'x']`
  compiles, and `findInexactMarks` flags it. A schema-derived brand on `TypeFromEntrySchema`'s
  reference, image and block types would remove the guessing.
- **Digit-string segments.** `fieldProps(['sections', '0', 'headline'])` is refused by the type,
  while `normalizeCanopyPath` reads `'0'` as an index. Stricter than the runtime, so safe.
- **Plain function types.** `FieldProps<T>` is not assignable to
  `(path: string | readonly CanopyPathSegment[]) => FieldAttrs`. An adopter prop typed that way
  stops compiling; plain `FieldProps` is the escape hatch.
- **In-flight report.** `usePreviewMarks` checks a report against the draft when the report
  arrives. A report the page sent for draft D1 that arrives after the editor posted D2 is checked
  against D2. If D2 removed an item D1's marks named, one `console.warn` fires for that path and,
  through the once-per-path set, never repeats. The toggle's count corrects itself on the next
  report.
- **Weak e2e assertion.** `apps/test-app/e2e/tests/preview-highlight-focus.spec.ts` asserts
  `not.toHaveAttribute('aria-description')` right after the mark count arrives; it would pass if
  the editor had not yet rendered the report.
