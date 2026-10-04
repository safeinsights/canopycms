import { trimSlashes } from './paths/normalize'
import { isIndexSlug } from './utils/entry-url'

/**
 * Resolve a URL path to the candidate entryPath/slug pairs a lookup should try, in order:
 *
 * 1. Direct entry: last segment is the slug, the rest is the collection path — SKIPPED when that
 *    slug is an index slug (see below).
 * 2. Index fallback: the whole path is a collection and the slug is 'index'.
 *
 * This is the REVERSE of the forward collection+slug -> url rule and must agree with it about how
 * many URLs an entry answers at. The forward rule — `computeEntryUrl` (utils/entry-url.ts), which
 * `listEntries` publishes as `item.urlPath` and reference resolution stamps on every resolved
 * reference, plus `defaultBuildPath` (content-tree.ts) for tree nodes — collapses an `index` slug
 * onto its collection's path and never emits a trailing `/index`.
 */
export function resolveUrlPathCandidates(
  urlPath: string,
  contentRoot: string,
): Array<{ entryPath: string; slug: string }> {
  const normalized = trimSlashes(urlPath)
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length === 0) return [{ entryPath: contentRoot, slug: 'index' }]

  const candidates: Array<{ entryPath: string; slug: string }> = []

  // Try 1: last segment is the entry slug, rest is the collection path.
  //
  // Skipped when that slug is an index slug: an index entry's ADVERTISED URL is its collapsed
  // collection path, so matching it here would answer at a second URL enumeration never emits.
  // `index` is the slug the index convention requires on disk, so the collision is structural
  // rather than contrived.
  //
  // This closes the `.../index` spelling only. The other extra URLs an entry can answer at —
  // `/<collection>/<entryTypeName>` via candidate 2, and `/<collection>/<entryTypeName>/<slug>`
  // via candidate 1 — are closed DOWNSTREAM instead, by `readByUrlPath` requiring every
  // candidate's `entryPath` to be a collection (`ReadContentInput.urlAddressableOnly`). They have
  // to be: telling those apart needs the branch's schema, and this module is deliberately pure and
  // schema-free so the candidate shapes stay a fact about URLs rather than about content. So the
  // candidates below are what is ATTEMPTED, not what can resolve.
  //
  // Compared case-INSENSITIVELY through the shared `isIndexSlug`: this function is the one consumer
  // that sees a raw, un-normalized URL segment (`parseSlug` and ContentStore's directory scan
  // lowercase downstream), so a strict compare would close `/x/index` while leaving `/x/Index` and
  // `/x/INDEX` resolving the very entry the skip exists to hide.
  const slug = segments[segments.length - 1]
  const collectionSegments = segments.slice(0, -1)
  const entryPath =
    collectionSegments.length > 0 ? `${contentRoot}/${collectionSegments.join('/')}` : contentRoot

  if (!isIndexSlug(slug)) {
    candidates.push({ entryPath, slug })
  }

  // Try 2: full path is a collection with an index entry.
  //
  // Kept unconditionally, which is what makes the skip above a skip rather than a removal: a
  // collection literally NAMED `index` is handed the path `/x/index` by
  // `defaultBuildPath(kind: 'collection')`, and this candidate is the only one that can answer it.
  candidates.push({
    entryPath: `${contentRoot}/${segments.join('/')}`,
    slug: 'index',
  })

  return candidates
}
