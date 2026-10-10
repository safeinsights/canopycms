---
priority: P3
summary: >-
  An `md` entry's body is checked as markdown unless its field sets `renderAs: 'mdx'`, so a body field typed `mdx` with an `mdxAllow` in an `md` entry type has an allowlist that never applies, and nothing says so. Refuse the combination where a schema meets its entry type's format.
---
# An `mdx`-typed body in an `md` entry type ignores its `mdxAllow`

**Priority:** P3. **Found:** 2026-10-09, request 101 review.

## Problem

`markdownPolicyOf` (`validation/mdx-allowlist.ts`) checks an entry's body by the entry's format: as
MDX in an `mdx` entry, and in an `md` entry only with `renderAs: 'mdx'`, since a site renders an
`.md` file as markdown and checking one as MDX refuses common markdown such as an HTML comment. A
body field typed `mdx` in an `md` entry type is therefore checked as markdown, and an `mdxAllow`
on it never applies. `markdownFieldOptionsError` cannot see this: a field does not know its entry
type's format, and `renderAs` is refused on an `mdx` field.

## Fix

Where a schema meets its entry type's format (`validateEntrySchemaRegistry`, or the schema load in
`branch-schema-cache.ts`), refuse an `md` entry type whose body field is typed `mdx` with an
`mdxAllow`, saying to type it `markdown` with `renderAs: 'mdx'`.
