# gray-matter's global cache aliases nested md/mdx frontmatter across reads

**Priority: P3 [BOTH].** Latent: nothing mutates nested frontmatter today, but it is shared mutable
state in a hot read path.

## The mechanism

`gray-matter@4` keeps a **process-global cache keyed by file content**. A repeat `matter(raw)`
returns a fresh *file* object but the **same `data` object instance**
(`matter(raw).data === matter(raw).data` is `true`). `ContentStore.read()`'s md branch
(`content-store.ts`, line 944) and `readEntryData` in `content-listing.ts` (line 84) copy the **top
level** (`{ ...parsed.data }`), so a body merged into the frontmatter no longer poisons the cache.

## What remains: nested aliasing

Every **nested** frontmatter object (`seo: { title, description }`, a nested list of objects) still
aliases the global cache across occurrences, calls and requests. A caller that mutates
`doc.data.seo.title` rewrites it for every later reader in the process, including other requests in a
warm Lambda container. Mutating a nested value on one `matter()` result is visible to a later
independent `matter()` of the same content.

`resolveSingleReference`'s cached path is the safer of the two: it hands out a `structuredClone`.
The uncached path (plain `read()`) is the one that aliases.

## Fix

Either deep-copy in the md branch of `read()` and in `readEntryData`, or pass `{ cache: false }` to
`matter()` and give up the cache. Measure first; gray-matter's cache skips only the *parse*, not the
`fs.readFile`, so it may not be a win. Then say which in [concurrency.md](../../docs/concurrency.md),
whose reference-resolve-cache row points here for this caveat.

## Related

- [resolved-reference-shape.md](resolved/resolved-reference-shape.md)
- [shared-blocks-listentries-caveat.md](resolved/shared-blocks-listentries-caveat.md)
