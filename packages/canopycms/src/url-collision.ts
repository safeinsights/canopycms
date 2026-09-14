import fs from 'node:fs/promises'
import path from 'node:path'

import { extractSlugFromFilename } from './content-id-index'
import { isIndexSlug } from './utils/entry-url'
import { isNotFoundError } from './utils/error'
import { parseTypedFilename } from './utils/typed-filename'

/**
 * Every extension `getFormatExtension` can return.
 *
 * Compared CASE-SENSITIVELY, deliberately, because `listCollectionEntries` compares
 * case-sensitively (`d.name.endsWith(ext)` against lowercase extensions). Lowercasing here makes
 * the guard looser than the listing: a `doc.index.{id}.MD` file would count as a claimant while
 * the listing skips it silently — publishing no URL, tripping no build error, and blocking a
 * write the build would have accepted.
 *
 * KNOWN RESIDUAL LOOSENESS: the listing accepts only the extensions of a collection's OWN
 * configured entry-type formats, while this accepts all four, so a hand-authored
 * `doc.index.{id}.json` inside an md-only collection claims no URL yet still blocks a sibling
 * write. Closing it means threading each collection's configured formats into a deliberately
 * schema-free module; tracked in
 * .claude/future-tasks/url-collision-guard-superset-of-listing.md.
 *
 * A literal rather than derived: deriving it needs the `ContentFormat` union this module has no
 * reason to import. `url-collision.test.ts` carries the drift tripwire — a compile-time
 * exhaustiveness check plus a fixture per format — so adding a format fails there rather than
 * silently under-blocking here.
 */
const CONTENT_EXTENSIONS = ['.md', '.mdx', '.json', '.yaml'] as const

/**
 * The WRITE-BOUNDARY half of the invariant "no two entries may claim the same `urlPath`".
 *
 * The build-time half (`assertNoDuplicateUrlPaths`, static/index.ts) detects the state; this
 * refuses to create it. Neither replaces the other: content is git-backed, so it also arrives by
 * merge, PR, direct commit and retrofit of an existing repo — none of which pass this boundary —
 * while the build guard cannot help an editor about to author the collision right now. A SCHEMA
 * edit alone can create one with no content write at all: `updateEntryType` changing a format
 * changes the listing's `validExts`, which can turn a `guide.index.{id}.json` the listing skipped
 * into a published entry, and so into a contested pair.
 *
 * Deliberately formulated on `urlPath`, not on names. An entry whose slug matches a sibling
 * collection is only a problem when that collection ALSO has an index entry:
 *
 *   content/docs/page.guides.{id}.json + content/docs/guides.{id}/  (no index)  -> fine: a
 *     landing page plus a folder of children, both reachable, nothing contested.
 *   content/docs/page.guides.{id}.json + content/docs/guides.{id}/doc.index.{id}.md -> contested:
 *     both compute /docs/guides, so exactly one is reachable and the other has no route.
 *
 * A name-collision rule would forbid the first, a shape adopters legitimately build. Everything
 * here works on PHYSICAL directories, because that is what the write path holds when it needs the
 * answer, and the on-disk names carry the content IDs logical paths hide (`guides.{id}/`).
 *
 * SCOPE, and do not widen it by accident: this guards the URL an ENTRY claims -- the `urlPath`
 * `computeEntryUrl` derives and `listEntries` publishes -- not "every URL the site serves".
 * Hand-written adopter routes, and a sitemap `<loc>` a framework adapter rewrites after
 * enumeration (`generateContentSitemap`'s `pathFor`), are invisible here by design: at write time
 * there is no filesystem state to check them against.
 */

/** One entry that already claims the `urlPath` a pending write would produce. */
export interface UrlPathClaimant {
  /**
   * Which of the two shapes was found. Callers word their own message from this: for
   * `sibling-collection-index` the author should rename their new entry, for `parent-entry` they
   * are adding the index entry that makes an existing pair contested.
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
 * The slug a file CLAIMS A URL AT, or null when the file claims none.
 *
 * This must recognise the set `listEntries` recognises, as closely as a schema-free module can,
 * because the invariant is defined over the `urlPath`s `listEntries` publishes and the build-time
 * half checks those. Hence `parseTypedFilename` — the same `{type}.{slug}.{id}.{ext}` grammar
 * `listCollectionEntries` uses — rather than `extractSlugFromFilename`, which answers the much
 * looser "what would I call this file?" and happily names a slug for things that are not entries.
 *
 * Getting this wrong OVER-BLOCKS, which is worse here than under-blocking: a hand-authored
 * `index.md` with no content ID, an `index.md~` editor backup or a colocated `guides.png` are
 * non-entries that claim no URL, so the build guard ignores them — but a looser scan counts them
 * as claimants and refuses a legitimate write, telling the author to "remove that collection's
 * index entry" about a file Canopy does not consider an entry. Worst for retrofitted repos.
 *
 * The claimant set is nonetheless a strict superset of the listing's in three ways, all
 * over-blocking and all needing the same fix — the schema this module deliberately does not have
 * — so they are one task (.claude/future-tasks/url-collision-guard-superset-of-listing.md):
 *
 *   1. extension — see `CONTENT_EXTENSIONS` above;
 *   2. entry TYPE — parsing is structural (no `entryTypes` list), so a file whose type is not in
 *      the collection's config is skipped by the listing but counted here. In the editor, where
 *      this guard runs, the listing skips such a file with a debug-gated warning and nothing
 *      surfaces; only a BUILD reports it. Reached by renaming an entry type in `.collection.json`
 *      without renaming the files — the accident `looksLikeMalformedEntry` names as most common;
 *   3. collection-hood — `findChildCollectionDir` matches any child directory by name, but a
 *      directory with no `.collection.json` is not a collection, so nothing inside it publishes
 *      a URL. Narrow (the file inside still needs valid entry grammar) but the same direction.
 */
function entrySlugOf(filename: string): string | null {
  // `parseTypedFilename` strips the extension without checking it, so an editor backup
  // (`doc.index.{id}.md~`) parses exactly like the entry it shadows. `listCollectionEntries`
  // additionally requires a configured format extension, so this must skip those too, or the
  // guard refuses a write over a file the build guard never counted.
  if (!CONTENT_EXTENSIONS.some((ext) => filename.endsWith(ext))) return null
  return parseTypedFilename(filename)?.slug ?? null
}

/**
 * The index entry file directly inside `dir`, or null. Slug extraction is entry-type-agnostic
 * (each candidate's type is read out of its own filename), so an index entry of ANY type counts —
 * like the same-slug guard, deliberately cross-type because the URL does not care what type
 * serves it.
 */
export async function findIndexEntryIn(dir: string): Promise<string | null> {
  for (const entry of await readDirSafe(dir)) {
    if (entry.isDirectory()) continue
    if (isIndexSlug(entrySlugOf(entry.name) ?? undefined)) return path.join(dir, entry.name)
  }
  return null
}

/** The entry file directly inside `dir` whose slug is `slug`, or null. */
export async function findEntryBySlugIn(dir: string, slug: string): Promise<string | null> {
  const wanted = slug.toLowerCase()
  for (const entry of await readDirSafe(dir)) {
    if (entry.isDirectory()) continue
    if (entrySlugOf(entry.name) === wanted) return path.join(dir, entry.name)
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
 * conflict), so re-checking it would be a second source of truth.
 *
 * Two directory reads at worst, and only on create/rename — an ordinary save never calls this,
 * because the entry's URL is not changing and any collision predates the write.
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

    // A collection literally NAMED "index" collapses onto ITS OWN path (`<parentPath>/index`), not
    // onto `<parentPath>` -- see `computeEntryUrl`. The only entry that could contest it is a
    // parent entry whose slug is also "index", but by that same forward rule such an entry IS the
    // parent's own landing entry, at `<parentPath>`, a different URL. Nothing in the parent can
    // claim `<parentPath>/index`, so skip the lookup rather than let it match the parent's index
    // entry and report a collision that does not exist -- otherwise a collection named "index"
    // could never have a landing page under a parent that has one of its own.
    if (isIndexSlug(ownName)) return null

    const claimant = await findEntryBySlugIn(parentDir, ownName)
    return claimant ? { kind: 'parent-entry', physicalPath: claimant, name: ownName } : null
  }

  // A plain entry sits at the same URL as a same-named child collection's index entry.
  //
  // KNOWN DEPENDENCY: this resolves ONE child collection by name, and the index direction above
  // likewise looks only for a parent ENTRY. Neither considers a second collection sharing the same
  // name, because nothing stops one being created -- `createCollectionInner` does not check
  // sibling names (tracked in collection-sibling-name-uniqueness.md). With two `guides.{id}`
  // directories side by side, an index entry can be written into each: both writes pass this
  // guard, two entries claim one URL, and only the build guard catches it. Fixing sibling-name
  // uniqueness closes this without changing anything here, so that task is a prerequisite for
  // this guard being complete.
  const childDir = await findChildCollectionDir(collectionDir, slug)
  if (!childDir) return null
  const indexEntry = await findIndexEntryIn(childDir)
  return indexEntry
    ? { kind: 'sibling-collection-index', physicalPath: indexEntry, name: slug }
    : null
}
