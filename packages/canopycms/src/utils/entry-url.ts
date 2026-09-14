/**
 * Shared entry URL computation, used by server and client code alike. No server-only
 * dependencies, so it is safe to import into browser bundles.
 */

import { trimSlashes } from '../paths/normalize'

/**
 * Is this slug the collection-index slug? The shared home for that decision — every forward and
 * reverse URL rule routes through it (see utils/AGENTS.md), and it is re-exported from
 * `canopycms/server` for adopters.
 *
 * The compare is lowercased because slug matching is case-insensitive throughout CanopyCMS
 * (`parseSlug` lowercases; `ContentStore` resolves slugs by a lowercased directory scan): a bare
 * `slug === 'index'` is correct only where the input is already normalized, and silently wrong
 * for callers handling raw URL segments or on-disk names.
 */
export function isIndexSlug(slug: string | undefined): boolean {
  return slug?.toLowerCase() === 'index'
}

/**
 * Compute a URL path from an entry's collection path and slug: strip the `contentRoot` prefix,
 * append the slug unless it is an index slug, lowercase. Always starts with `/`.
 *
 * Examples:
 *   ("content/posts", "hello-world", "content") => "/posts/hello-world"
 *   ("content/docs/api", "index", "content")    => "/docs/api"
 *   ("content", "index", "content")              => "/"
 */
export function computeEntryUrl(collection: string, slug: string, contentRoot: string): string {
  const root = trimSlashes(contentRoot)

  let stripped = collection
  if (root && collection.startsWith(`${root}/`)) {
    stripped = collection.slice(root.length + 1)
  } else if (collection === root) {
    stripped = ''
  }

  const segments = stripped.split('/').filter(Boolean)

  if (slug && !isIndexSlug(slug)) {
    segments.push(slug)
  }

  const path = segments.length > 0 ? `/${segments.join('/')}` : '/'
  // Lowercase to match content-listing.ts and content-tree.ts URL conventions
  return path.toLowerCase()
}
