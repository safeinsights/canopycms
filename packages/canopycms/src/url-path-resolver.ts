/**
 * Resolves a URL path to candidate entryPath/slug pairs for content lookup.
 *
 * Returns an ordered list of attempts:
 * 1. Direct entry: last segment is slug, rest is collection path
 * 2. Index fallback: full path is collection, slug is 'index'
 *
 * @param urlPath - URL path like '/docs/guides/getting-started' or 'docs/guides'
 * @param contentRoot - Content root directory name (default: 'content')
 * @returns Array of { entryPath, slug } candidates to try in order
 */
export function resolveUrlPathCandidates(
  urlPath: string,
  contentRoot: string,
): Array<{ entryPath: string; slug: string }> {
  const normalized = urlPath.replace(/^\/+|\/+$/g, '')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length === 0) return []

  const candidates: Array<{ entryPath: string; slug: string }> = []

  // Try 1: last segment is the entry slug, rest is the collection path
  const slug = segments[segments.length - 1]
  const collectionSegments = segments.slice(0, -1)
  const entryPath =
    collectionSegments.length > 0 ? `${contentRoot}/${collectionSegments.join('/')}` : contentRoot

  candidates.push({ entryPath, slug })

  // Try 2: full path is a collection with an index entry
  candidates.push({
    entryPath: `${contentRoot}/${segments.join('/')}`,
    slug: 'index',
  })

  return candidates
}
