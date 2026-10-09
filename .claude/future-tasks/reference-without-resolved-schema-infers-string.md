---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-09. A reference field without `resolvedSchema` infers as `string | null`, but `read()` and live preview deliver the resolved entry (or an `unavailable` reference) there. `isResolvedReference` on such a value therefore narrows to `string & {resolved reference}`, where string methods compile and throw. Infer it as `string | resolved | UnavailableReference | null`, or as the resolved shapes alone
---
# A reference without `resolvedSchema` is typed as its id, not what reads deliver

**Status:** Open. **Priority: P3.** Filed 2026-10-09 from review of
[preview-reference-resolution-depth.md](resolved/preview-reference-resolution-depth.md).

## State

`InferContentShape` (`entry-schema.ts`) types a reference field that has no `resolvedSchema` as
`string | null`. That is the stored value, but `read()` resolves references by default and the
live preview always does, so a view receives an object (or `null`).

`isResolvedReference` must narrow to a subtype of its input, so for `string | null` it yields
`string & Record<string, unknown> & ResolvedReferenceMeta`: `urlPath` and `id` read correctly,
but `value.toUpperCase()` also compiles and throws at runtime.

## Options

1. Infer `string | (Record<string, unknown> & ResolvedReferenceMeta) | UnavailableReference |
   null`, so `isResolvedReference` narrows to the record arm. Widening an adopter's type is a
   breaking change for code that treats the field as a string.
2. Infer the resolved shapes only when the schema is used for reads, which needs a separate
   read-shape type.
