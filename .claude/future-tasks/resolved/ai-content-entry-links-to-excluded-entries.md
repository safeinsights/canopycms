---
priority: P3
summary: >-
  A body `entry:ID` link in AI content resolves to its target's URL even when `exclude` leaves the target out of the export, so the URL (and the slug in it) of an excluded entry, e.g. a draft, appears in the output. Reference fields are masked to `(unavailable entry <id>)` for exactly this case; body links are not.
---

# AI content: body `entry:` links reveal the URL of an excluded entry

`generate.ts` runs `resolveEntryLinksInText` over each md/mdx body before the export set is known,
and the resolver links to any entry in the id index. A reference field to the same target renders
as `(unavailable entry <id>)` (`maskUnexportedTargets` in `ai/references.ts`), so one AI document
can hide an excluded target in a field and still link it in the body.

## Proposed fix

Resolve body links in the second phase of `generateAIContent`, once the exported ids are known,
and point a link to a target outside them at `#`, as the resolver already does for a missing
target.
