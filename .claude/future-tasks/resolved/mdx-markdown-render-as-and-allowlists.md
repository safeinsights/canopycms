---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `feat/mdx-safety-markdown-and-allowlists`, base `int-202610-b` (request 101). A `markdown` field with `renderAs: 'mdx'` gets the `mdx` policy; `mdxAllow` (per field, plus a site default in canopy config, merged key by key) narrows it to named components with allowed props and values, a subset of the safe HTML tags, and optionally no inert expressions or fragments. The allowlist only narrows. The rich-text toolbar writes no tag a field refuses.
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

- `renderAs: 'mdx'` on a `markdown` field (refused on `mdx`; only upgrades) runs the `mdx` policy,
  with the same unchanged-content rule. The editor already parses both field types as MDX.
- `mdxAllow` (`MdxAllowlist`): `components` (name → `props` → `true` or allowed values),
  `htmlTags`, `expressions`, `fragments`. Omitted keys keep the base policy. Field keys replace site
  keys. Config validation (zod, and `createEntrySchemaRegistry`) refuses tags outside the safe set,
  non-component names, always-refused props, misspelt keys, and `mdxAllow` with `executable` or on a
  plain markdown field.
- The editor's toolbar hides Underline and image resize when `u`/`img` are refused, and a Lexical
  node transform drops underline, sub and sup formats however applied.

Pasting HTML holding a sized `<img>` still makes an `<img>` the server refuses with a clear
message; the toolbar cannot produce one.
