import { trimSlashes } from './paths/normalize'
import { isIndexSlug } from './utils/entry-url'

/**
 * Resolves a URL path to candidate entryPath/slug pairs for content lookup.
 *
 * Returns an ordered list of attempts:
 * 1. Direct entry: last segment is slug, rest is collection path — SKIPPED when that slug is
 *    literally 'index' (see below)
 * 2. Index fallback: full path is collection, slug is 'index'
 *
 * This is the REVERSE of the forward collection+slug -> url rule, and the two must agree on how
 * many URLs an entry answers at. The forward rule (`computeEntryUrl` in utils/entry-url.ts, which
 * `listEntries` publishes as `item.urlPath` and reference resolution stamps on every resolved
 * reference; and `defaultBuildPath` in content-tree.ts for tree nodes) collapses an `index` slug
 * onto its collection's path and never emits a trailing `/index`. Candidate 1 used to match it
 * anyway, so an index entry ALSO answered at a `.../index` URL that no forward surface publishes
 * — enumeration and resolution disagreeing about how many URLs exist. Adopters paid for that with
 * per-route entryType gates whose only job was to reject the phantom.
 *
 * @param urlPath - URL path like '/docs/guides/getting-started' or 'docs/guides'
 * @param contentRoot - Content root directory name (default: 'content')
 * @returns Array of { entryPath, slug } candidates to try in order
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
  // Skipped when that slug is an index slug. An index entry's ADVERTISED URL is its collapsed
  // collection path, so matching it here would answer at a second URL enumeration never emits.
  // `index` is not a contrived segment either — it is the slug the index convention requires on
  // disk, so the collision was structural rather than accidental.
  //
  // This closes the `.../index` spelling, NOT every extra URL: candidate 2 below still resolves an
  // index entry at `/<collection>/<entryTypeName>`, because that path is a registered entry-TYPE
  // schema item which `buildPaths` delegates to the parent collection. Open, and tracked in
  // .claude/future-tasks/readbyurlpath-entry-type-candidate-phantom-url.md.
  //
  // Compared case-INSENSITIVELY, through the shared `isIndexSlug`. This function is the one
  // consumer that sees a raw, un-normalized URL segment — everything downstream lowercases
  // (`parseSlug`, and ContentStore's directory scan) — so a strict compare here closed
  // `/x/index` while leaving `/x/Index` and `/x/INDEX` resolving the very entry it exists to hide.
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
  // (Candidate 1 used to shadow that collection entirely, returning the parent's own index entry.)
  candidates.push({
    entryPath: `${contentRoot}/${segments.join('/')}`,
    slug: 'index',
  })

  return candidates
}
