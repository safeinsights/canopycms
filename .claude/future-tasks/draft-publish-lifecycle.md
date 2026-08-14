# Draft/publish as a first-class content lifecycle

## Priority: P1 [BOTH]

From the 2026-08-13/14 site audits of `../docs-site-proto` and `../website`,
triaged as part of the 2026-08-14 go-live backlog re-baseline. No existing
task file covered this.

## Why this is high value

An author who tries to hide a page from the public site — the single most
basic content-lifecycle operation — currently ships it anyway on at least one
site. That's not a rough edge; it's the exact failure that makes a
non-technical editor stop trusting the tool.

## The KB's `draft` field is a phantom (verified finding)

`docs-site-proto`'s own README and CLAUDE.md tell authors `draft` is a
frontmatter field they can set to hide a page. It isn't real:
`src/app/schemas.ts` never declares a `draft` field anywhere — the only
`draft` in the schema is a `reviewStatus` *option* on datasets
(`schemas.ts:263`), a different concept entirely. **No content file in the
repo sets it.** Three filters that check for a `draft` value are therefore
dead code, silently doing nothing. An author who reads the docs, sets
`draft: true` in frontmatter, and hits publish gets exactly what they were
trying to prevent: the page goes live.

## What's missing generally

CanopyCMS itself has no schema-level, enforced concept of draft/published —
"published" is purely a content-field convention today (per
`static-export-sitemap.md`'s "What's available to build on"), not something
the schema, the editor UI, or `read()`/`listEntries` understand or enforce.
Every adopter is left to invent their own convention, and the KB's shows what
happens when the convention exists only in docs and not in code: it silently
rots.

## Proposed shape (needs design, not just implementation)

- A schema-level `status` or `published` concept CanopyCMS understands
  natively — at minimum a documented, validated field name/type contract that
  `defineEntrySchema`/`defineBlockTemplate` can opt into, so "did I remember
  to add the draft field to my schema" isn't a silent no-op the way it is for
  the KB today.
- Editor UI affordance (a visible draft/published toggle or badge, not just a
  frontmatter checkbox nobody surfaces).
- Enforcement points: static build (exclude drafts from generated pages),
  `listEntries`/sitemap (exclude by default, opt-in include), and ideally a
  lint/validation step that catches a schema declaring the convention wrong
  the way the KB's did — this would have caught the KB's phantom field at
  schema-resolution time instead of silently doing nothing for however long
  it's been broken.

## Related

- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md) — the
  broader editorial-workflow design task this slots into (schema changes vs.
  branches, long vs. short-lived branches, sync). Draft/publish is a
  concrete, scoped slice of that larger space and can be designed
  independently of it.
- [resolved-references-url.md](resolved-references-url.md) and
  [listentries-acl-awareness.md](listentries-acl-awareness.md) — both touch
  what `listEntries` returns; a native draft/published concept should be
  designed alongside whatever those land, not after.
