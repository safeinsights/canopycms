# `readByUrlPath('/<entryTypeName>')` resolves a collection's index entry — a second URL the forward rule never emits

**Priority:** P2 — breaks a documented invariant and is now reachable in the shape the README
recommends, but no in-repo app serves a route for the phantom URL today
**Found:** 2026-08-21, by an independent review of `feat/sitemap-path-for-index-entries`
(adopter request log #20). Pre-existing; that branch created the first live instance.

## Problem

`AGENTS.md` states the invariant plainly: the forward rule (`computeEntryUrl`) and the reverse one
(`resolveUrlPathCandidates`) must agree that an index entry answers at **exactly one** URL, its
collapsed collection path. PR #253 closed the `/x/index` half of that. This is a second, distinct
hole in the same invariant, and it is still open.

`resolveUrlPathCandidates('/home', 'content')` returns two candidates:

```
[ { entryPath: 'content',      slug: 'home'  },   // 1: last segment is the slug
  { entryPath: 'content/home', slug: 'index' } ]  // 2: whole path is a collection with an index
```

Candidate 2 assumes `content/home` is a **collection**. When the content root declares an entry
**type** named `home`, `content/home` is a registered entry-type schema item instead
(`config/flatten.ts`), and `ContentStore.buildPaths`' entry-type branch (`content-store.ts`,
`effectiveSlug = slug || schemaItem.name`) delegates it to the **parent** collection with slug
`index` — which resolves that collection's index entry.

So a root index entry answers at both `/` and `/home`. Generalised: for any collection that has an
index entry, `/<collection>/<entryTypeName>` also resolves it — the scan matches on slug alone, so it
holds even when the index entry's own type differs from the probed name. One exception: if that
collection also holds a real entry whose slug literally equals the entry-type name, candidate 1 wins
and that entry answers instead, which is a collision rather than a phantom.

## Confirmed, not inferred

Probed against a real `ContentStore` over a replica of `apps/example1`'s root collection (entry
type `home`, `maxItems: 1`, single file `home.index.<id>.json`):

```
candidates("/home") -> [{content, 'home'}, {content/home, 'index'}]
read(content/home, index)  => { hero: 'Welcome home' }   <-- resolves
read(content, index)       => { hero: 'Welcome home' }   <-- the legitimate '/' route
```

## Why it matters more now

`README.md` recommends modelling a home page as a root `index` entry (the modelling that removes
the sitemap workaround — see adopter request log #20). That recommendation is right, and it is also
what makes this hole reachable: an adopter combining it with a root catch-all (`app/[[...slug]]`)
serves a **duplicate homepage** at `/home`, with no warning. `apps/example1` is not affected today
because it has no root catch-all, so `/home` has no route and Next 404s it — but nothing enforces
that, and the README now carries a caveat pointing here.

`assertNoDuplicateUrlPaths` does not catch this: it scans `urlPath` values from the forward
enumeration, and the forward rule never emits `/home` at all. The disagreement is one-directional,
which is exactly what makes it invisible.

## Suggested fix

The fix belongs in URL resolution, **not** in `ContentStore`. The entry-type delegation in
`buildPaths` is a deliberate, documented feature of direct `ContentStore`/`read({ entryPath })`
usage, with its own test (`content-store.test.ts`, "entry-type path delegation") — narrowing it
would break a supported API.

Make `readByUrlPath` (`context.ts`) skip the index-fallback candidate when its `entryPath` resolves
to an entry-**type** schema item rather than a collection. The forward rule never emits
`/<collection>/<typeName>`, so that candidate can only ever produce a phantom URL.

The obstacle, and the reason this was not fixed inline, is narrower than "no schema is reachable" —
an earlier draft of this file overstated it. `context.ts`'s `getContext` closure DOES resolve a flat
schema, via `services.branchSchemaCache.getSchema(branchRoot, registry, contentRootName)` inside
`resolveSchemaContextImpl`, a few dozen lines below `readByUrlPath`. Two things still stand in the
way: that flat schema is a list, not a logicalPath-keyed index, so a lookup would have to be built;
and `resolveSchemaContextImpl` is memoized against the DEFAULT branch, while `readByUrlPath` takes a
per-call `branch` — so reusing it as-is would consult the wrong branch's schema for any non-default
read. Options, roughly in order of preference:

1. Expose a narrow predicate off `ContentStore` (it already holds `this.schemaIndex`), e.g.
   `isCollectionPath(logicalPath)`, and consult it in the candidate loop.
2. Thread the flattened schema into `readByUrlPath` and check there.
3. Have the candidate carry an "only if this is a collection" flag that the reader honours.

Whichever is chosen, add tests for: the phantom is gone (`/home` -> null), the legitimate
candidate-2 case still resolves (`/docs/guides` -> the guides index entry), a collection literally
named `index` still resolves, and direct `read({ entryPath: 'content/home' })` is untouched.

## Related

- [adopter-request-log-intake.md](adopter-request-log-intake.md) — item #20, whose fix exposed this
- [resolved/url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md)
  — the `/x/index` half of the same invariant, closed by PR #253
- [isurlpath-field-marker.md](isurlpath-field-marker.md) — its "singletons are routable" bullet is
  about this same area
