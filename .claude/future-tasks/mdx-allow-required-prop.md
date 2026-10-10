---
priority: P3
adopters: BOTH
summary: >-
  `mdxAllow` cannot require a prop: with `title: 'string'`, `<Callout>` with no `title` (or
  `title=""`) still passes, so a renderer that needs a non-empty title fails the static build.
  Consider `required: true` and `minLength` on the `{ type: 'string' }` allowance
---

# `mdxAllow` cannot require a prop or a non-empty string

**Priority:** P3 (a save the site cannot render; no adopter has asked yet).

## What happens

`mdxAllow` checks only the props an element writes. A `'string'` allowance
(`packages/canopycms/src/config/types.ts`, `MdxPropAllow`) refuses a bare attribute and any `{…}`
value, but an element that omits the prop passes, as does an empty or whitespace-only quoted
string. A renderer that requires a non-empty `title` then receives `undefined` or `""`, shows
"Not shown in preview", and fails the static build, the failure the `'string'` allowance exists to
prevent for bare attributes.

## Possible fix

Extend the object form, `{ type: 'string', maxLength?, minLength?, required? }`. Enforce
`required` in `checkJsxElement` (`packages/canopycms/src/validation/markdown-safety.ts`) once per
element after the attribute loop, naming the missing prop. Zod-validate both keys in
`config/schemas/field.ts`. Decide whether `minLength` counts trimmed text.
