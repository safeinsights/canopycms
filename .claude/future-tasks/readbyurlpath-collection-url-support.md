# Support collection URLs and root path in readByUrlPath

## Problem

`readByUrlPath` currently only resolves to **entries** (individual content files). It returns `null` for:

- Root path `/` — `resolveUrlPathCandidates` returns `[]` for empty segments
- Collection paths like `/docs/` — tries to find a `docs` entry or `index` under root, not the collection itself

This means adopters can't use `readByUrlPath` as a one-stop resolver for all URL patterns. They must use `buildContentTree` or `listEntries` separately for collection-level pages.

## Design Options

### Option 1: Keep entry-only, document the boundary

Keep `readByUrlPath` focused on entries. Document that `/` and collection-level URLs need `buildContentTree` or `listEntries`. This is the simplest approach and avoids API complexity.

### Option 2: Add root index fallback

Make `readByUrlPath('/')` try `{ entryPath: contentRoot, slug: 'index' }` as a candidate. This handles the common case of a root index entry without changing the return type. Collection paths would still return `null`.

### Option 3: Return a discriminated union

Return `{ kind: 'entry', data } | { kind: 'collection', entries }` for collection-level URLs. This would let adopters use `readByUrlPath` everywhere but significantly complicates the API surface and return type.

## Recommendation

Start with Option 2 (root index fallback) — it's a small, backward-compatible change that handles the most common gap. Evaluate Option 3 only if adopters report needing collection-level resolution frequently.

## Affected Files

- `packages/canopycms/src/url-path-resolver.ts` — add root path candidate
- `packages/canopycms/src/url-path-resolver.test.ts` — update tests
- `packages/canopycms/README.md` — update docs
