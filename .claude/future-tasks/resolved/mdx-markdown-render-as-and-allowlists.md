---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `feat/mdx-safety-markdown-and-allowlists`, base `int-202610-b` (request 101). A `markdown` field with `renderAs: 'mdx'` gets the `mdx` policy; `mdxAllow` (per field, plus a site default in canopy config, merged key by key) narrows it to named components with allowed props and values, a subset of the safe HTML tags, and optionally no inert expressions or fragments. The allowlist only narrows. The rich-text toolbar writes no tag a field refuses; paste still can (filed).
---
# The MDX safety policy misses markdown rendered as MDX, and cannot be narrowed

**Status: RESOLVED 2026-10-09**, branch `feat/mdx-safety-markdown-and-allowlists`; see the summary.

**Priority:** P1 [BOTH]. **Found:** 2026-10-09, adopter request 101, against `0.0.68-int.108`.

## Problem

The save-time MDX policy (`validation/markdown-safety.ts`) checked a `markdown` field for URL
schemes only. An adopter storing bodies as `type: 'markdown'` and rendering them through its own
MDX pipeline could not delete its `validateEntry` refusal: `{expressions}`, `import`/`export` and
`<script>` would save and break the next build. And on `mdx` fields the policy accepted what a
narrow site must refuse: inert expressions and comments, fragments, any capitalised component,
the safe HTML tags, and any prop or prop value on a component.

## Resolution

- `renderAs: 'mdx'` on a `markdown` field (refused on `mdx`) runs the `mdx` policy, with the same
  unchanged-content rule. `markdownPolicyOf` (`validation/mdx-allowlist.ts`) is the one rule for how
  a field is checked, used by the save path, the build scan and the editor: an `mdx` entry's body is
  MDX whatever its field type, an `md` entry's body only with `renderAs: 'mdx'`.
- `mdxAllow` (`MdxAllowlist`): `components` (name → `props` → `true` or allowed values),
  `htmlTags`, `expressions`, `fragments`. Omitted keys keep the base policy. Field keys replace site
  keys. Config validation (zod, and `createEntrySchemaRegistry`) refuses tags outside the safe set,
  non-component names, always-refused props, misspelt keys, a `renderAs` other than `'mdx'`, and
  `mdxAllow` with `executable` or on a plain markdown field. A stored issue's key carries the
  field's resolved allowlist, so stored content is kept only under the allowlist it was stored
  under.
- The editor hides Underline and image resize when `u`/`img` are refused, and refuses the commands
  adding underline, sub or sup, in nested editors too, while letting removal through. It never
  rewrites content.

Follow-ups: pasting rich text still writes a refused tag, which the save refuses
([mdx-allowlist-paste-writes-refused-tags.md](../mdx-allowlist-paste-writes-refused-tags.md)); an
`mdx`-typed body in an `md` entry type is checked as markdown, so its `mdxAllow` never applies
([mdx-typed-body-in-md-entry-ignores-mdxallow.md](../mdx-typed-body-in-md-entry-ignores-mdxallow.md)).
