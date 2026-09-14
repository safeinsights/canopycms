import { isValidId } from '../id'
import type { EntryTypeConfig } from '../config'
import type { ContentId, Slug } from '../paths/types'

// Lives here rather than in content-listing.ts so dependency-light modules can use it:
// content-listing imports ContentStore, so url-collision.ts (which content-store imports) cannot
// reach back into it without a cycle. content-listing and `canopycms/server` re-export it.

/**
 * Parse a Canopy content filename into its `{type}.{slug}.{id}.{ext}` parts.
 *
 * The slug may itself contain dots (`getting.started.guide`), so type and ID anchor the split:
 * the ID is the second-to-last dot-separated segment, the slug is everything between the type and
 * it (lowercased), and the extension is stripped. The ID is a 12-character Base58 content ID, and
 * a would-be ID segment that fails `isValidId` rejects the whole parse.
 *
 * `filename` must be a bare filename, and **that precondition is not enforced**: the parser splits
 * purely on `.`, so a `/` or `\` is neither rejected nor treated as special and becomes part of
 * whichever segment it falls in (`'foo/bar.slug.<validId>.md'` gives `type: 'foo/bar'`). Strip the
 * directory component yourself (`path.basename`) — every internal caller does. A leading-dot
 * filename is always rejected, matching `extractEntryTypeFromFilename` in `content-id-index.ts`.
 *
 * `entryTypes`, when given, restricts the `type` segment to those entry types — how
 * `listCollectionEntries` filters out files that do not belong to the collection. Omit it to
 * parse structurally, for adopter code recovering `{type, slug, id}` with no schema on hand.
 *
 * `id` is validated and safe to trust. **`slug` is not** — it is the raw dot-joined middle,
 * lowercased and cast to the branded `Slug` without `parseSlug`'s validation, so a slug holding a
 * space or a dot still parses and still carries the brand. Callers needing a validated slug run
 * `parseSlug` themselves. `listCollectionEntries` does NOT, so a dotted slug is listed and
 * advertised (sitemap, `generateStaticParams`) yet can never be read back through `readByUrlPath`,
 * which runs every candidate through `parseSlug`; `static/index.ts`'s `assertRoutableSlugs` is the
 * build-time guard for that.
 */
export const parseTypedFilename = (
  filename: string,
  entryTypes?: readonly EntryTypeConfig[],
): { type: string; slug: Slug; id: ContentId } | null => {
  // A leading dot can never be a legal entry type, and a dotfile is exactly what a structural
  // (no-entryTypes) parse would otherwise misparse: '.hidden.file.aB3cD4eF5gH6.md' -> type ''.
  if (filename.startsWith('.')) return null

  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1) return null
  const nameWithoutExt = filename.slice(0, lastDot)

  const parts = nameWithoutExt.split('.')
  if (parts.length < 3) return null

  const potentialType = parts[0]
  if (entryTypes && !entryTypes.some((e) => e.name === potentialType)) {
    return null
  }

  const id = parts[parts.length - 1]
  if (!isValidId(id)) return null
  const slug = parts.slice(1, -1).join('.').toLowerCase()
  return {
    type: potentialType,
    slug: slug as Slug,
    id: id as ContentId,
  }
}
