# Clarify API "id" Field Naming

This prompt was from another session. You can make different plans / recommendations.  See @CLAUDE.md and associated files.

## Background

The `CollectionItem` interface in the entries API has a semantically confusing "id" field that contains a **logical path** rather than a **content ID**.

**Current situation** ([api/entries.ts:214-215](packages/canopycms/src/api/entries.ts#L214-L215)):
```typescript
export interface CollectionItem {
  id: string              // Contains "content/posts/hello" (logical path)
  slug: string
  collectionId: string
  collectionName: string
  // ... other fields
}

// Set as:
id: `${collection.fullPath}/${slug}`  // e.g., "content/posts/hello"
```

## The Problem

There are **two different concepts** both called "id" in the codebase:

1. **Logical Path (Entry Path)**: User-facing identifier for navigation and URLs
   - Example: `"content/posts/hello-world"`
   - Used in: API responses as the `id` field
   - Used for: Editor URLs, breadcrumbs, navigation

2. **Content ID (Short UUID)**: Globally unique identifier embedded in filenames
   - Example: `"vh2WdhwAFiSL"` (12-character Base58)
   - Used in: Filenames, references between content, `ContentIdIndex`
   - Used for: Internal linking, reference resolution

**The confusion:**
- API returns `entry.id = "content/posts/hello"` (logical path)
- But the entry's actual unique ID is `vh2WdhwAFiSL` (embedded in filename)
- Code comments sometimes say "entry ID" when they mean "logical path"
- Adopters may be confused about which "id" to use for references

## Evidence of Confusion

1. **editor-utils.ts:178**:
   ```typescript
   schemaByCollection.get(entry.id) ?? // For root entries, check by entry ID (entry-type fullPath)
   ```
   Comment says "entry ID" but code uses logical path.

2. **api/entries.ts:284**:
   ```typescript
   id: item.fullPath,  // EntryCollectionSummary - also uses fullPath as "id"
   ```

3. **Missing content ID in API**: The actual short UUID is never exposed in the API, only the logical path.

## Investigation Required

Before deciding on a fix, investigate:

1. **Where is `CollectionItem.id` used?**
   - Search codebase for uses of `entry.id` or `item.id` from API responses
   - Check editor components, URL construction, selection logic
   - Determine if any code expects it to be a UUID vs a path

2. **Is the logical path the right identifier for the API?**
   - For editor navigation: Yes, logical paths are correct
   - For content references: No, should use short UUIDs
   - For selection keys: Currently works, but semantically wrong

3. **Should we expose the content ID in the API?**
   - Would it be useful for reference fields?
   - Would it help with deduplication or caching?
   - Or is it purely internal?

4. **Impact on adopters:**
   - Do any adopters rely on the current `id` field?
   - Would renaming break existing integrations?
   - Is this pre-1.0 so we can make breaking changes?

## Possible Solutions

### Option 1: Rename `id` to `path` (Breaking Change)
```typescript
export interface CollectionItem {
  path: string            // "content/posts/hello" (logical path)
  contentId: string       // "vh2WdhwAFiSL" (short UUID) - NEW
  slug: string
  collectionId: string
  // ...
}
```

**Pros:**
- Clear semantic distinction
- Content ID exposed for references
- Matches internal nomenclature

**Cons:**
- Breaking change for adopters
- Requires migration of editor code

### Option 2: Add `contentId` alongside `id` (Non-Breaking)
```typescript
export interface CollectionItem {
  id: string              // "content/posts/hello" (deprecated, use path)
  path: string            // "content/posts/hello" (logical path) - NEW
  contentId: string       // "vh2WdhwAFiSL" (short UUID) - NEW
  slug: string
  // ...
}
```

**Pros:**
- Non-breaking
- Gradual migration path
- Exposes both identifiers

**Cons:**
- Redundancy during transition
- Doesn't fully resolve confusion

### Option 3: Keep as-is, Document Intent
```typescript
export interface CollectionItem {
  id: string              // Logical path for navigation (e.g., "content/posts/hello")
  slug: string
  collectionId: string
  // ...
  // Note: The content ID (short UUID) is internal and not exposed
}
```

**Pros:**
- No code changes
- No breaking changes

**Cons:**
- Doesn't resolve semantic confusion
- Content ID still not accessible

## Recommended Approach

Know that breaking changes are acceptable, because there are no adopters currently (only the two test apps in apps/)

1. **Investigate first**: Understand all uses of `entry.id` in editor and adopter code
3. **Decide on solution**:


4. **If renaming**:
   - Update `CollectionItem` interface
   - Update all API response construction
   - Update editor components using `entry.id`
   - Update tests
   - Add migration guide to CHANGELOG

## Files to Investigate

1. [api/entries.ts](packages/canopycms/src/api/entries.ts) - API response construction
2. [api/types.ts](packages/canopycms/src/api/types.ts) - CollectionItem interface
3. [editor/hooks/useEntryManager.ts](packages/canopycms/src/editor/hooks/useEntryManager.ts) - Selection logic
4. [editor/utils/editor-utils.ts](packages/canopycms/src/editor/utils/editor-utils.ts) - Entry manipulation
5. Search for: `entry.id`, `item.id`, `CollectionItem`

## Deliverables

At the end of this session:

1. **Investigation findings**: Document all uses of `entry.id` and impact of changes
2. **Recommendation**: Which option to pursue based on codebase analysis
3. **If implementing change**:
   - Update API types and response construction
   - Update editor code to use new field names
   - Add content ID extraction from filenames
   - Update all tests
   - Add deprecation warnings if non-breaking approach
4. **Documentation**: Update API docs to clarify identifier semantics

## Success Criteria

- ✅ Clear semantic distinction between logical paths and content IDs
- ✅ API field names match their actual content
- ✅ All tests pass
- ✅ No confusion in code comments
- ✅ Adopters have clear migration path (if breaking change)
