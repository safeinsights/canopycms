/**
 * Shared entry URL computation — used by both server and client code.
 *
 * This module has NO server-only dependencies (no node:fs, etc.)
 * so it can be safely imported into browser bundles.
 */

import { trimSlashes } from '../paths/normalize'

/**
 * Is this slug the collection-index slug?
 *
 * The shared home for that decision. Six sites route through here: `computeEntryUrl` below,
 * `content-tree.ts`'s `defaultBuildPath`, `content-reader.ts`'s `buildEntryPath` and the
 * editor's `buildPreviewSrc` (the four forward-rule implementations), the reverse
 * `resolveUrlPathCandidates`, and `canopycms-next`'s `collectStaticParams`, which skips index
 * entries for a single-segment route. Re-exported from `canopycms/server` for adopters. (`content-tree.ts`'s `indexEntry` lookup still does its own
 * `slug === 'index'`; it is fed slugs already lowercased by the listing, so it is safe rather
 * than shared.) Slug matching is case-insensitive throughout
 * CanopyCMS (`parseSlug` lowercases, and `ContentStore` resolves slugs by a lowercased
 * directory scan), so this compares lowercased — a bare `slug === 'index'` is correct only
 * for callers whose input was already normalized, and silently wrong for the ones handling
 * raw URL segments or on-disk names. `resolveUrlPathCandidates` was exactly that case: its
 * strict compare left `/x/Index` resolving the index entry after `/x/index` stopped.
 */
export function isIndexSlug(slug: string | undefined): boolean {
  return slug?.toLowerCase() === 'index'
}

/**
 * Compute a URL path from an entry's collection path and slug.
 *
 * Logic:
 * - Strip the contentRoot prefix (e.g., "content/") from the collection path
 * - Append the slug (unless it's "index", which collapses to the parent path)
 * - Always returns a path starting with "/"
 *
 * Examples:
 *   ("content/posts", "hello-world", "content") => "/posts/hello-world"
 *   ("content/docs/api", "index", "content")    => "/docs/api"
 *   ("content", "index", "content")              => "/"
 */
export function computeEntryUrl(collection: string, slug: string, contentRoot: string): string {
  const root = trimSlashes(contentRoot)

  // Strip contentRoot prefix
  let stripped = collection
  if (root && collection.startsWith(`${root}/`)) {
    stripped = collection.slice(root.length + 1)
  } else if (collection === root) {
    stripped = ''
  }

  // Build URL segments
  const segments = stripped.split('/').filter(Boolean)

  // Append slug unless it's an index slug (index entries collapse to parent)
  if (slug && !isIndexSlug(slug)) {
    segments.push(slug)
  }

  const path = segments.length > 0 ? `/${segments.join('/')}` : '/'
  // Lowercase to match content-listing.ts and content-tree.ts URL conventions
  return path.toLowerCase()
}
