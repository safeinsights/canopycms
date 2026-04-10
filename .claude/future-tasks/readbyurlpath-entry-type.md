# Return entryType from readByUrlPath

## Summary

`readByUrlPath()` currently returns `{ data: T; path: string }`. Add `entryType: string` to the result so consumers can route based on content type without needing dedicated Next.js routes or separate `listEntries` lookups.

## Motivation

When a Next.js catch-all route (`[...slug]/page.tsx`) reads content via `readByUrlPath`, it doesn't know whether the result is a doc page (MDX body → DocView), a structured data page (JSON/YAML → custom component), or something else. Currently the only way to distinguish is:

1. Create separate Next.js route files for each content type (e.g., `data-catalog/page.tsx` alongside `[...slug]/page.tsx`)
2. Use `listEntries` with URL path filtering to get the `entryType` (inefficient)
3. Inspect the data shape to guess the type (fragile)

Adding `entryType` to the result enables clean entry-type-based routing in a single catch-all:

```typescript
const result = await canopy.readByUrlPath(`/${slug.join('/')}`);
switch (result.entryType) {
  case 'home': return <HomePage data={result.data} />;
  case 'partner': return <PartnerPage data={result.data} />;
  default: return <DocView data={result.data} />;
}
```

## Implementation Notes

The entry type is already known during URL resolution — it comes from the schema item matched in `resolveUrlPath`. It just needs to be passed through to the return value.

The same enhancement would be useful on `read()` as well.

## Requested By

docs-site-proto — migrating from hardcoded pages to structured Canopy content entries with multiple schemas (docSchema, homeSchema, partnerSchema). Currently working around this with dedicated Next.js routes per content type.
