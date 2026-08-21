import fs from 'node:fs/promises'
import path from 'node:path'

import { extractSlugFromFilename } from './content-id-index'
import { isIndexSlug } from './utils/entry-url'
import { isNotFoundError } from './utils/error'

/**
 * The WRITE-BOUNDARY half of the invariant "no two entries may claim the same `urlPath`".
 *
 * The build-time half (`assertNoDuplicateUrlPaths`, static/index.ts) detects the state; this
 * refuses to create it. Neither replaces the other: content is git-backed, so it also arrives by
 * merge, by PR, by direct commit and by adopters retrofitting an existing repo — none of which
 * pass through this boundary — while the build guard cannot help an editor who is about to author
 * the collision right now.
 *
 * Deliberately formulated on `urlPath`, not on names. An entry whose slug matches a sibling
 * collection is only a problem when that collection ALSO has an index entry:
 *
 *   content/docs/guides.json          + content/docs/guides.{id}/  (no index)  -> fine.
 *     A landing page plus a folder of children. Both are reachable; nothing is contested.
 *
 *   content/docs/guides.json          + content/docs/guides.{id}/doc.index.{id}.md
 *     -> contested. Both compute /docs/guides, so exactly one of them is reachable and the
 *        other silently has no route.
 *
 * A name-collision rule would forbid the first, which is a shape adopters legitimately build.
 *
 * Everything here works on PHYSICAL directories, because that is what the write path holds when
 * it needs the answer, and because the on-disk names carry the content IDs that logical paths
 * hide (`guides.{id}/`, `doc.index.{id}.md`).
 */

/** One entry that already claims the `urlPath` a pending write would produce. */
export interface UrlPathClaimant {
  /**
   * Which of the two shapes was found. Callers word their own message from this, because the
   * actionable advice differs: for `sibling-collection-index` the author should rename their new
   * entry, for `parent-entry` they are adding the index entry that makes an existing pair
   * contested.
   */
  kind: 'sibling-collection-index' | 'parent-entry'
  /** Absolute path of the file already claiming that URL. */
  physicalPath: string
  /** The contested logical name — the sibling collection's name, or the parent entry's slug. */
  name: string
}

/** Read a directory, treating "missing" as empty. Anything else is a real error and propagates. */
async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (isNotFoundError(err)) return []
    throw err
  }
}

/** The child directory of `dir` whose logical name is `name`, or null. */
async function findChildCollectionDir(dir: string, name: string): Promise<string | null> {
  const wanted = name.toLowerCase()
  for (const entry of await readDirSafe(dir)) {
    if (!entry.isDirectory()) continue
    if (extractSlugFromFilename(entry.name) === wanted) return path.join(dir, entry.name)
  }
  return null
}

/**
 * The index entry file directly inside `dir`, or null.
 *
 * Slug extraction is entry-type-agnostic (each candidate's own type is read out of its filename),
 * so an index entry of ANY entry type counts — same reasoning as the existing same-slug guard,
 * which is deliberately cross-type because the URL does not care what type serves it.
 */
export async function findIndexEntryIn(dir: string): Promise<string | null> {
  for (const entry of await readDirSafe(dir)) {
    if (entry.isDirectory()) continue
    if (isIndexSlug(extractSlugFromFilename(entry.name))) return path.join(dir, entry.name)
  }
  return null
}

/** The entry file directly inside `dir` whose slug is `slug`, or null. */
export async function findEntryBySlugIn(dir: string, slug: string): Promise<string | null> {
  const wanted = slug.toLowerCase()
  for (const entry of await readDirSafe(dir)) {
    if (entry.isDirectory()) continue
    if (extractSlugFromFilename(entry.name) === wanted) return path.join(dir, entry.name)
  }
  return null
}

/**
 * Would an entry at `collectionDir` with slug `slug` land on a `urlPath` some OTHER entry already
 * claims? Returns the offender, or null when the write is clear.
 *
 * Only the cross-collection shapes are checked here. An entry colliding with another entry in the
 * SAME collection is already refused upstream (`ContentStore.buildPaths` resolves a write by a
 * type-agnostic slug scan, and the `expectedVersion: null` create-intent guard turns that into a
 * conflict), so re-checking it would be duplicate work and a second source of truth.
 *
 * Two directory reads at worst, and only on create/rename — an ordinary save of an existing entry
 * never calls this, because the entry's URL is not changing and the collision (if any) predates
 * the write.
 *
 * @param contentRoot Absolute path of the content root. A root-level index entry claims `/`, which
 *   nothing above it can contest, so the `parent-entry` check stops here rather than walking out
 *   of the content tree.
 */
export async function findUrlPathClaimant(opts: {
  collectionDir: string
  slug: string
  contentRoot: string
}): Promise<UrlPathClaimant | null> {
  const { collectionDir, slug, contentRoot } = opts

  if (isIndexSlug(slug)) {
    // Adding an index entry collapses this collection onto its own path, which an entry sitting
    // beside the collection in the PARENT may already hold.
    const resolvedRoot = path.resolve(contentRoot)
    if (path.resolve(collectionDir) === resolvedRoot) return null // a root index claims '/', uncontestable
    const parentDir = path.dirname(collectionDir)
    const ownName = extractSlugFromFilename(path.basename(collectionDir))
    const claimant = await findEntryBySlugIn(parentDir, ownName)
    return claimant ? { kind: 'parent-entry', physicalPath: claimant, name: ownName } : null
  }

  // A plain entry sits at the same URL as a same-named child collection's index entry.
  const childDir = await findChildCollectionDir(collectionDir, slug)
  if (!childDir) return null
  const indexEntry = await findIndexEntryIn(childDir)
  return indexEntry
    ? { kind: 'sibling-collection-index', physicalPath: indexEntry, name: slug }
    : null
}
