# `read()`'s `path` is a phantom URL when `entryPath` names an entry type

## Priority: P3 [BOTH]

## The gap

`content-reader.ts`'s `buildEntryPath` builds `path` from the REQUESTED `entryPath` and slug, not
from the collection the entry resolved in. `ContentStore.buildPaths` delegates an entry-type
`entryPath` to its parent collection, so `read({ entryPath: 'content/blog/article', slug: 'hello' })`
reads `content/blog/article.hello.<id>.json` and reports `meta.urlPath` `/blog/hello`, but `path`
`/blog/article/hello?branch=main` — a URL `readByUrlPath` refuses (`urlAddressableOnly` rule 1),
so a caller linking `path` links to a 404.

`readByUrlPath` and `createPreviewPage` never reach this: their `entryPath` is always a
collection. Only a structural `read()` through an entry-type path does. The singleton case
`read({ entryPath: 'content/home' })` happens to come out right (`/home`).

## Suggested shape

Build `path` from `meta.urlPath` (the resolved `collectionPath` and slug through
`computeEntryUrl`) plus `?branch=`, and drop `buildEntryPath`'s own content-root strip and
encoding — which also closes most of [default-build-path-url-rule-copy.md](default-build-path-url-rule-copy.md)'s
concern for this builder. Check whether any caller depends on `path` keeping a slug's casing or
percent-encoding (slugs pass `validateSlug`, which may admit characters `computeEntryUrl` leaves
unencoded). Then tighten the `path` doc comment in `ContentReader`, which currently warns about
this case.
