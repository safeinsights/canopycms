---
priority: P3
summary: >-
  AI content resolves `entry:` links only in an md/mdx entry's body. A `markdown`/`mdx` field in a JSON entry, or a string frontmatter field, prints its `[text](entry:ID)` links raw, so the AI output carries dead `entry:` URLs where the site's pages (which run `resolveEntryLinksInData`) show working links.
---

# AI content: `entry:` links inside fields stay unresolved

`ai/generate.ts` runs `resolveEntryLinksInText` over `entry.body` only. `content-reader.ts`
resolves links in every string of an entry's data (`resolveEntryLinksInData`), so a JSON page whose
`hero.body` markdown links another entry renders a working link on the site and a raw
`entry:<id>` in `/ai`.

## Proposed fix

Resolve links in `entry.data` strings in the same render round as the body, with the same
`isLinkable` bound to the exported set, so a link to a left-out entry still renders as its text.
Reference values must be skipped, and the result must not change what `exclude.where` sees.
