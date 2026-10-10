---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED: an `mdxAllow` prop allowance can be `'string'`, or `{ type: 'string', maxLength }`,
  which accepts only a quoted literal (`title="…"`, `''` included) and refuses a bare attribute and
  every `{…}` value. `maxLength` counts code points. `true` is unchanged and documented as admitting
  a bare attribute and any `{…}` value the base policy accepts
---

# `mdxAllow` cannot require a string prop

**Priority:** P2 (a save the site cannot render). **Found:** adopter request 103, against
0.0.68-int.109.

## What happened

A site allowed `<Callout title="…">` with any text as `props: { title: true }`. `true` also admits
a bare `<Callout title>`, which MDX gives the value `true`, and any `{…}` value. The site's renderer
requires a string `title`, so such a body saved cleanly, previewed as "Not shown in preview", and
then failed the static build on the editor's PR, with no message the author could act on.

## Resolution

`MdxPropAllow` (`packages/canopycms/src/config/types.ts`) gains `'string'` and
`{ type: 'string'; maxLength?: number }`, zod-validated strictly in `config/schemas/field.ts`.
`checkJsxElement` in `validation/markdown-safety.ts` enforces them after every base-policy check:
anything but a quoted literal is refused with "Prop title on <Callout> must be a quoted string, e.g.
title="…"", and a literal over `maxLength` code points with "must be at most N characters". With
`expressions: false`, a `{…}` value is refused earlier by the existing message.

`'boolean'` and `'number'` were left out: `[true, false]` already expresses a boolean exactly, and
no site asked for numbers. The editor runs no client-side prop check, so the save refusal, which
names the line, is what steers the author.
