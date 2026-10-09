---
priority: P3
summary: >-
  On an md/mdx entry's AI markdown, a frontmatter metadata line prints a `select` as its raw value rather than its option label, and a `list: true` scalar (select, string, image) as `String(array)`, e.g. `typed,fast`. The JSON-entry path labels a single select and renders lists as bullets, though a select list's bullets are raw values too.
---

# AI content: md/mdx metadata lines print raw select values and comma-glued lists

`renderMarkdownEntry` (`ai/json-to-markdown.ts`) writes each scalar frontmatter field through
`formatInlineValue`, which handles only `boolean`, `reference` and `image`. Everything else is
`String(value)`, so:

- a `select` prints its stored value, not the label `resolveSelectLabel` gives a JSON entry's
  single select;
- a `list: true` select or string prints as `a,b`, with no space and no labels;
- a `list: true` image prints `[object Object],[object Object]`.

## Proposed fix

Give `formatInlineValue` a select case through `resolveSelectLabel`, and join any array value
per element with `, `, as the reference case already does. Changes existing output for md
entries, so it needs a migration-note line.
