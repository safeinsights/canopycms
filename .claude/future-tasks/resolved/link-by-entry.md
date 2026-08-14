# Link-by-Entry Support

## Problem

Internal links in MDX content currently use hardcoded URL paths (e.g., `/researchers/start-here/study-lifecycle/`). If a slug or directory structure changes, these links silently break. This is especially problematic when content is managed through CanopyCMS where slugs may be edited by content authors.

## Proposed Solution

Add a link-by-entry mechanism that resolves to the current URL path at build time. Options:

1. **Markdown link syntax**: `[text](entry:slug-or-id)` parsed by a remark/rehype plugin that resolves the entry's current path via `canopy.readEntry()` or similar
2. **MDX component**: `<EntryLink entry="slug-or-id">text</EntryLink>` that resolves during static generation
3. **Frontmatter aliases**: Allow entries to declare stable IDs that the link resolver uses for lookup

## Canopy API Needs

- A way to look up an entry's current URL path by a stable identifier (slug, ID, or alias)
- This should work at build time for static export sites
- Consider whether `listEntries` with a filter or a dedicated `resolveEntryUrl(identifier)` API makes more sense

## Context

This came up during docs-site-proto content improvements where 6+ pages had broken cross-references (bold text references like "see the **Study Lifecycle**" without actual links). These were fixed with hardcoded paths for now.
