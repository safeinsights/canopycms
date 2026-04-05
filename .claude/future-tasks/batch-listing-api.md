## Feature: Batch listing API for static generation and search indexing

### Problem

Consumers that need all entries for static generation (`generateStaticParams`) or search indexing currently have to walk the content directory manually, re-implementing Canopy's filename parsing, ID stripping, and slug normalization. This has already led to bugs where the consumer's parsing diverged from Canopy's (case normalization issues).

The docs-site currently has `src/lib/content-utils.ts` with ~100 lines of filesystem walking code (`parseCanopyFile`, `parseCanopyDir`, `collectPages`) that duplicates logic Canopy already has internally — specifically `extractSlugFromFilename`, `resolveCollectionPath`, and schema-driven content discovery.

### Proposed API

```typescript
const entries = await canopy.listEntries({
  includeBody?: boolean,   // include MDX/markdown body content (for search indexing)
  filter?: (entry) => boolean,  // e.g., skip drafts
});

// Returns:
interface EntryListItem {
  slug: string[];           // URL path segments, e.g., ['researchers', 'guides', 'glossary-of-terms']
  collectionPath: string;   // e.g., 'content/researchers/guides'
  title: string;
  description?: string;
  body?: string;            // only if includeBody: true
  draft?: boolean;
  [key: string]: unknown;   // other frontmatter fields
}
```

### Use Cases

1. **`generateStaticParams`** — needs all slug arrays to pre-render pages
2. **Search index building** — needs slug, title, and body content for every non-draft entry
3. **Sitemap generation** — needs all URL paths

### Current Workarounds

`buildContentTree` is close but doesn't return body content or flat slug arrays. Consumers end up bypassing Canopy entirely with direct filesystem reads, which means slug parsing and case normalization happen in two places instead of one.

### Notes

The API should work in build/static contexts (no auth, no server) since `generateStaticParams` and search index scripts run at build time. Consider whether this should be a method on the Canopy context or a standalone utility that takes a content root path.
