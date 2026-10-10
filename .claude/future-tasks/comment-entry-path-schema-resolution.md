---
priority: P3
adopters: NEITHER
summary: >-
  A new comment thread's `entryPath` is gated by its spelling (content-root prefix, no empty or `.` segments), not resolved against the schema, so a slug-case alias (`content/secret/PLAN` for `content/secret/plan`) misses an exact-slug read-deny rule and stores a thread on the alias. Nothing leaks; resolve `entryPath` the way `api/content.ts` does and store that spelling
---

# Resolve a comment's entry path against the schema before gating it

`api/comments.ts` checks a new thread's `entryPath` against path rules after a spelling check
(`isCanonicalEntryPath`): rooted at the content root, no empty or `.` segment. The content API
instead resolves a path through `ContentStore.resolvePath`, which lowercases the slug, so
`content/secret/PLAN` reads the entry `content/secret/plan`. A path rule naming that exact slug
does not match the uppercase spelling (minimatch is case-sensitive), so a user denied read on
`content/secret/plan` can create a thread tagged `content/secret/PLAN`.

**Why it is P3:** no disclosure. The editor attaches threads to entries by exact string
(`FormRenderer.tsx`, `useEntryManager.ts`), so the alias thread never appears on the real entry,
and glob rules (`content/secret/**`) match either case.

**Why lowercasing the stored path is not the fix:** listed entry paths keep the slug's case from
the filename (`content-listing.ts` builds `entryLogicalPath(collection, slug)` from the parsed
filename), so lowercasing would detach comments from an entry whose file has an uppercase slug.

## Proposed fix

Give the add route the `branchAccessWithSchema` guard, resolve `entryPath` with
`store.resolvePath`, refuse what does not resolve, and gate and store
`entryLogicalPath(schemaItem.logicalPath, slug)`. First settle how uppercase-slug files should
behave, since the content API already lowercases their slug on read.
