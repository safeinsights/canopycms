# A resolved reference to an md/mdx entry carries frontmatter but no body

**Status:** Open, needs a product decision before any code. **Priority: P2** — it blunts the
headline use case of adopter request #16 for exactly the content format the README recipe
recommends.

## What happens

`resolveSingleReferenceOnce` returns `{ id, slug, collection, ...doc.data }`. For an md/mdx
target, `ContentStore.read()` puts frontmatter on `doc.data` and the **body on `doc.body`**, so
the body is never spread in. A resolved reference to an md snippet therefore carries its
frontmatter fields and none of its prose.

This is long-standing `read()` behavior, not new. What makes it worth a decision now is that
`listEntries({ resolveReferences: true })` shipped in #16 specifically so that **a search index
can see the text inside shared blocks** — and for an md-format snippet, that text is precisely
what is missing. The README's "Shared / Referenced Blocks" recipe presents a snippet-style entry
type as the normal shape, so adopters will hit this on the recommended path.

Note the inconsistency it creates within one listing: a **listed** md entry's `data` *does*
carry the body (`readEntryData` merges it under the entry type's `bodyFieldName`), while a
**resolved reference** to that same entry does not. Same call, same entry, two shapes.

Until #16 this was masked, and confusingly so: gray-matter's global cache meant a resolved md
reference sometimes did come back with a `body` key — but only when an unrelated part of the
same listing had parsed that file first. That was a bug and is fixed; see
[graymatter-cache-shared-frontmatter.md](graymatter-cache-shared-frontmatter.md). The behavior is
now deterministic, and deterministically without the body.

## The decision

**Should a resolved reference to an md/mdx entry include the target's body under its
`bodyFieldName`?**

- **Yes** — the search-index case works on the recommended content shape without adopters
  hand-rolling a second `read()`, and resolved references match listed entries.
  Cost: it changes what `read()`/`readByUrlPath()` return for every existing caller with a
  reference field pointing at an md entry — a shape change with no compile error behind it,
  the same hazard that made `listEntries`' own `resolveReferences` opt-in. It also makes
  resolved objects much larger, which matters for the per-occurrence `structuredClone` in the
  batch cache (see the measured numbers in `resolveSingleReference`'s doc comment: a large
  payload is where cloning stops being nearly free).
- **No** — leave it, and document the frontmatter-only shape prominently so adopters reach for
  a `read()` on the target when they need its prose.
- **Opt-in third option** — a flag on resolution, e.g. `resolveReferences: 'withBody'`. Keeps
  every existing caller's shape and serves the search-index case, at the cost of a third state
  in an option that is currently a clean boolean.

Whichever way it goes, README's "Resolving References in a Listing" needs a sentence — it
currently says resolution works "exactly as `read()`/`readByUrlPath()` do" without noting that,
for md/mdx, that means frontmatter only.

## Related

- [graymatter-cache-shared-frontmatter.md](graymatter-cache-shared-frontmatter.md) — the caching
  bug that used to mask this.
- [resolved-references-url.md](resolved-references-url.md) — a resolved reference also carries
  no `urlPath`; both are "what should a resolved reference contain" questions and could be
  decided together.

[BOTH]
