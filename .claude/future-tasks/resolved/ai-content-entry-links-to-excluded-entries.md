---
priority: P3
summary: >-
  RESOLVED (2026-10-11), folded into [ai-content-ignores-noindex.md](ai-content-ignores-noindex.md). A body `entry:` link in AI content is resolved only once the export set is settled, and a link to an entry the export leaves out (by `exclude`, `noindex`, or a failed render) renders as its plain link text, with no URL or slug; any other form of the link points at `#`.
---

# AI content: body `entry:` links reveal the URL of an excluded entry

## Status: RESOLVED 2026-10-11

`generate.ts` keeps each md/mdx body as stored and resolves its `entry:` links in each render
round, through `resolveEntryLinksInText`'s `isLinkable` option bound to the exported set. An
inline markdown link (or image) to a withheld or missing target becomes its bracketed text; a
reference-style definition, HTML `href` or bare token becomes `#`. An entry whose render fails
leaves the export, and every entry whose body links to it renders again. Reference fields keep
their `(unavailable entry <id>)` masking.
