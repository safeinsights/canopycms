# URL path handling: listEntries urlPath + readByUrlPath root support

## Problem 1: listEntries doesn't provide URL-ready paths

`listEntries` returns raw `pathSegments` that include `'index'` for collection index entries:

```
pathSegments: ['data-catalog', 'openstax', 'index']  // raw from filesystem
```

Every consumer that builds URLs must independently collapse index entries:

```ts
// This pattern is duplicated in every adopter codebase:
const segments = entry.slug === 'index' ? entry.pathSegments.slice(0, -1) : entry.pathSegments
```

docs-site-proto currently does this in three places:

- `generateStaticParams` (page.tsx)
- Search index builder (build-search-index.ts)
- Navigation tree builder (canopy-helpers.ts `buildPath`)

Canopy already knows which entries are index entries — the slug comes from the filename `doc.index.{id}.mdx`. This collapsing logic should live in Canopy, not in every consumer.

### Proposed fix

Add a `urlPath` field to `ListEntriesItem` that provides the collapsed, URL-ready path:

```ts
interface ListEntriesItem<T> {
  pathSegments: string[] // ['data-catalog', 'openstax', 'index'] — raw, as today
  urlPath: string // '/data-catalog/openstax' — collapsed, ready for URLs
  slug: Slug // 'index'
  // ... rest unchanged
}
```

Rules:

- If `slug === 'index'`, strip the last segment from `urlPath`
- Otherwise, `urlPath` = `'/' + pathSegments.join('/')`

This is backward-compatible — `pathSegments` stays unchanged for consumers that need the raw structure.

### Affected files

- `packages/canopycms/src/content-listing.ts` — add `urlPath` to `ListEntriesItem`, compute in `listEntries()`
- `packages/canopycms/src/content-listing.test.ts` — test index collapsing

## Problem 2: readByUrlPath doesn't handle root path

`readByUrlPath` returns `null` for:

- Root path `/` — `resolveUrlPathCandidates` returns `[]` for empty segments

This means adopters can't use `readByUrlPath('/')` to read a root index entry. They must special-case it with `canopy.read({ entryPath: 'content', slug: 'index' })`.

Note: collection paths like `/data-catalog/openstax` already work — the existing candidate logic tries `{ entryPath: 'content/data-catalog/openstax', slug: 'index' }` as a fallback. Only the root path is missing.

### Proposed fix (Option 2 from original design)

Make `readByUrlPath('/')` try `{ entryPath: contentRoot, slug: 'index' }` as a candidate. Small, backward-compatible change.

### Design alternatives considered

- **Option 1: Keep entry-only, document the boundary** — Keep `readByUrlPath` focused on entries. Document that `/` needs special handling. Simplest but pushes work to adopters.
- **Option 3: Return a discriminated union** — Return `{ kind: 'entry', data } | { kind: 'collection', entries }` for collection-level URLs. Significantly complicates the API surface. Evaluate only if adopters report needing collection-level resolution frequently.

### Affected files

- `packages/canopycms/src/url-path-resolver.ts` — add root path candidate
- `packages/canopycms/src/url-path-resolver.test.ts` — update tests
- `packages/canopycms/README.md` — update docs
