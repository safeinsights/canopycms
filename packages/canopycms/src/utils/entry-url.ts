/**
 * Shared entry URL computation — used by both server and client code.
 *
 * This module has NO server-only dependencies (no node:fs, etc.)
 * so it can be safely imported into browser bundles.
 */

import { trimSlashes } from '../paths/normalize'

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

  // Append slug unless it's "index" (index entries collapse to parent)
  if (slug && slug !== 'index') {
    segments.push(slug)
  }

  const path = segments.length > 0 ? `/${segments.join('/')}` : '/'
  // Lowercase to match content-listing.ts and content-tree.ts URL conventions
  return path.toLowerCase()
}
