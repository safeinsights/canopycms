# A reference's inferred type promises a body the runtime omits without `includeBody`

**Status:** Open. **Priority: P3** — a type-level overstatement with a one-line adopter
workaround, split out of [resolved-reference-shape.md](resolved/resolved-reference-shape.md)
rather than left implicit.

## The gap

`ReferenceFieldConfig.includeBody` (added 2026-08-21) decides at runtime whether a resolved
reference carries the target's body. The **type** inference does not consult it.

`TypeFromEntrySchema` infers a resolved reference from the field's `resolvedSchema`. If that
schema declares a body field — which the target's real schema naturally does — the inferred
type has it, whether or not `includeBody` is set:

```ts
const snippetSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'prose', type: 'markdown', isBody: true },
])

// includeBody NOT set: prose is typed `string`, runtime value is `undefined`.
{ name: 'snippet', type: 'reference', resolvedSchema: snippetSchema }
```

Pre-existing in substance — before `includeBody` there was no way to get the body at all, so
the type over-promised unconditionally. `includeBody` is what makes the promise true; this
file is about the case where it is absent.

## Why it was not fixed with the rest

Tightening it means omitting the body field's key from the inferred shape when `includeBody`
is absent, which needs a type-level equivalent of `findBodyFieldName`: walk the schema tuple
for `isBody: true`, fall back to the literal `'body'`, then `Omit` that key. Doable, but real
conditional-type machinery on a hot inference path (`InferContentShape` already recurses
through objects, groups and block templates), and the failure mode of getting it subtly wrong
is worse than the overstatement it fixes.

## Shape of the fix

In `entry-schema.ts`, alongside the existing `ResolvedReferenceMeta` intersection:

```ts
type BodyFieldNameOf<Fields> = /* find isBody: true, else 'body' */
F extends { type: 'reference'; resolvedSchema: infer S; includeBody: true }
  ? InferContentShape<S> & ResolvedReferenceMeta
  : F extends { type: 'reference'; resolvedSchema: infer S }
    ? Omit<InferContentShape<S>, BodyFieldNameOf<S>> & ResolvedReferenceMeta
    : ...
```

Verify against the existing type assertions in `entry-schema.test.ts`, which already cover
top-level, object-nested and `list: true` references.

## Adopter workaround meanwhile

Set `includeBody: true` on the field (making the type honest), or leave the body field out of
the `resolvedSchema` you pass — `resolvedSchema` is inference-only and need not be the
target's complete schema.

## Related

- [resolved-reference-shape.md](resolved/resolved-reference-shape.md) — the change that
  introduced `includeBody` and left this open.

[BOTH]
