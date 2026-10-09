---
priority: P3
summary: >-
  In AI content, an entry whose slug is `all` writes `<collection>/all.md`, which the collection's own `all.md` then overwrites, so the entry has no file and a reference's markdown-copy link to it opens the collection concatenation. The same happens to an entry in a `bundles` collection named like a configured bundle. Reserve those names, or give aggregate files their own namespace.
---

# AI content: an entry named `all` collides with its collection's `all.md`

`generate.ts` builds an entry's output path as `<collection>/<slug>.md` and the collection's
concatenation as `<collection>/all.md`, written after the entries. `parseSlug` accepts `all`, so an
entry with that slug loses its file. The manifest then lists `posts/all.md` both as the entry's
`file` and as the collection's `allFile`.

The collision predates reference links, but since every reference now links its target's markdown
copy, a reference to such an entry points at the wrong content. Nothing outside the export leaks.
A `bundles` collection whose entry slug matches a configured bundle name collides the same way
with `bundles/<name>.md`.

## Proposed fix

Either reject `all` (and bundle names under `bundles/`) as AI output names and say so in the build
output, or move aggregate files out of the per-entry namespace, e.g. `<collection>/_all.md`. The
second changes published URLs, so it needs a migration note.
