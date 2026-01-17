# Future Task: Flexible URL-to-Content Mapping System

## Problem

Currently, the URL mapping in `editor-utils.ts` (`buildPreviewSrc`) hardcodes the assumption that content path equals URL path. This prevents:

- `content/posts/my-post.md` mapping to `/blog/2024/my-post`
- Date-based URL structures
- Custom slug transformations
- Multiple URL patterns per collection

## Proposed Solution

### New Module: `/src/content-address/`

```
content-address/
├── index.ts          # Barrel exports
├── types.ts          # ContentAddress, UrlMappingRule types
├── registry.ts       # ContentAddressRegistry implementation
└── url-builder.ts    # URL template processing
```

### Key Types

```typescript
interface ContentAddress {
  contentPath: string // "content/posts/my-post"
  publicUrl: string // "/blog/2024/my-post"
  id: string // Stable content ID
  collectionId: string
  slug: string
}

interface UrlMappingRule {
  collection: string // "content/posts" or "content/docs/**"
  urlTemplate: string // "/blog/{field:publishDate|year}/{slug}"
  dateField?: string // "publishDate"
}

interface ContentAddressRegistry {
  getUrl(contentPath: string): string | null
  getContentPath(url: string): string | null
  register(address: ContentAddress): void
  buildUrl(entry: { collectionId: string; slug: string; data?: Record<string, unknown> }): string
}
```

### Config Extension

```typescript
defineCanopyConfig({
  urlMappings: [
    {
      collection: 'content/posts',
      urlTemplate: '/blog/{field:publishDate|year}/{field:publishDate|month}/{slug}',
      dateField: 'publishDate',
    },
    {
      collection: 'content/docs/**',
      urlTemplate: '/documentation/{slug}',
    },
  ],
})
```

### Template Variables

- `{slug}` - Entry slug
- `{field:fieldName}` - Value of a field
- `{field:fieldName|year}` - Year from date field
- `{field:fieldName|month}` - Month from date field
- `{field:fieldName|day}` - Day from date field

### Integration Points

1. **services.ts**: Create registry on init, provide via `CanopyServices.addressRegistry`
2. **editor-utils.ts**: Replace `buildPreviewSrc` hardcoded logic with registry lookup
3. **New API endpoints**:
   - `GET /api/canopycms/url-for-content?path=...`
   - `GET /api/canopycms/content-for-url?url=...`

### Bidirectional Lookup

The registry needs to support bidirectional lookup:

- Given content path, find public URL (for preview)
- Given public URL, find content path (for click-to-edit)

### Files to Modify

- `config.ts` - Add urlMappings schema
- `services.ts` - Integrate registry
- `editor-utils.ts` - Use registry in buildPreviewSrc

## Priority

Medium-high. Currently `previewBaseByCollection` provides a workaround, but this becomes critical when:

- Content reorganization (moving files without breaking URLs)
- Date-based blog URLs
- SEO-friendly URL structures different from content organization
