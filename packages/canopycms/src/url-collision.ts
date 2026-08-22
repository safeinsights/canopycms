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
 * case-sensitively (`d.name.endsWith(ext)` against lowercase extensions). Lowercasing here made
 * the guard looser than the listing: a `doc.index.{id}.MD` file counted as a claimant while the
 * listing skipped it silently — publishing no URL, tripping no build error, and blocking a write
 * the build would have accepted.
 *
 * KNOWN RESIDUAL LOOSENESS, stated because the alternative is a comment that overclaims: the
 * listing accepts only the extensions of a collection's OWN configured entry-type formats, while
 * this accepts all four. A hand-authored `doc.index.{id}.json` inside an md-only collection
 * therefore claims no URL yet still blocks a sibling write. Closing that means threading each
 * collection's configured formats into a module that is deliberately schema-free, across three
 * call sites, and going from a physical directory back to a schema item to do it — a change with
 * more room to introduce a new defect than the narrow one it fixes. Tracked in
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
 * merge, by PR, by direct commit and by adopters retrofitting an existing repo — none of which
 * pass through this boundary — while the build guard cannot help an editor who is about to author
 * the collision right now.
 *
 * A SCHEMA edit alone can also create one, with no content write at all: `updateEntryType`
 * changing a format changes the listing's `validExts`, which can flip a previously-unlisted
 * `guide.index.{id}.json` into a published entry and so into a contested pair. Another reason
 * neither half of this invariant subsumes the other.
 *
 * Deliberately formulated on `urlPath`, not on names. An entry whose slug matches a sibling
 * collection is only a problem when that collection ALSO has an index entry:
 *
 *   content/docs/page.guides.{id}.json + content/docs/guides.{id}/  (no index)  -> fine.
 *     A landing page plus a folder of children. Both are reachable; nothing is contested.
 *
 *   content/docs/page.guides.{id}.json + content/docs/guides.{id}/doc.index.{id}.md
 *     -> contested. Both compute /docs/guides, so exactly one of them is reachable and the
 *        other silently has no route.
 *
 * A name-collision rule would forbid the first, which is a shape adopters legitimately build.
 *
 * Everything here works on PHYSICAL directories, because that is what the write path holds when
 * it needs the answer, and because the on-disk names carry the content IDs that logical paths
 * hide (`guides.{id}/`, `doc.index.{id}.md`).
 *
 * SCOPE, and do not widen it by accident: this guards the URL an ENTRY claims -- the `urlPath`
 * that `computeEntryUrl` derives and `listEntries` publishes. It is NOT "every URL the site
 * serves", and the two are not the same set. A framework adapter can route an entry somewhere
 * else — adopters add hand-written routes Canopy knows nothing about, and a framework adapter can
 * rewrite a sitemap `<loc>` after enumeration (`generateContentSitemap`'s `pathFor` option, in
 * `canopycms-next/src/static.ts`, does exactly that). Those URLs are
 * invisible here by design -- there is no filesystem state to check them against at write time.
 * A future change that tries to make this the authority on "the set of URLs this site claims"
 * would be reaching past what the write boundary can actually see.
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
 * The slug a file CLAIMS A URL AT, or null when the file claims none.
 *
 * This must recognise the set `listEntries` recognises, as closely as a schema-free module can,
 * because the invariant is defined over the `urlPath`s `listEntries` publishes and the build-time
 * half checks those. (One documented gap remains — see `CONTENT_EXTENSIONS`.) Hence
 * `parseTypedFilename` — the same `{type}.{slug}.{id}.{ext}` grammar `listCollectionEntries` uses
 * — rather than `extractSlugFromFilename`, which answers a different and much looser question
 * ("what would I call this file?") and happily names a slug for things that are not entries.
 *
 * Getting this wrong OVER-BLOCKS, which is worse here than under-blocking: a hand-authored
 * `index.md` with no content ID, an `index.md~` editor backup, or a colocated `guides.png` are all
 * non-entries that claim no URL, so the build guard ignores them — but a looser scan counted them
 * as claimants and refused a legitimate write, telling the author to "remove that collection's
 * index entry" about a file Canopy does not consider an entry. That lands hardest on repos being
 * retrofitted onto CanopyCMS, which is precisely the audience this guard's migration note
 * addresses.
 *
 * Parsed structurally (no `entryTypes` list), which is the SECOND of three known ways this
 * claimant set is a strict superset of the listing's — all of them over-blocks, all of them
 * tracked together in .claude/future-tasks/url-collision-guard-superset-of-listing.md:
 *
 *   1. extension — see `CONTENT_EXTENSIONS` above;
 *   2. entry TYPE — a file whose type is not in the collection's config is skipped by the
 *      listing but counted here. An earlier version of this comment dismissed that as "already
 *      reported by the listing's malformed-file guard". That is true only in BUILD mode; in the
 *      editor, where this guard actually runs, `listCollectionEntries` skips such a file with a
 *      debug-gated warning and nothing surfaces. Reached by the accident
 *      `looksLikeMalformedEntry` itself names as most common: renaming an entry type in
 *      `.collection.json` without renaming the files;
 *   3. collection-hood — `findChildCollectionDir` matches any child directory by name, but a
 *      directory with no `.collection.json` is not a collection, so nothing inside it publishes
 *      a URL. Narrow (the file inside still needs valid entry grammar) but the same direction.
 *
 * All three need the same fix — the schema this module deliberately does not have — so they are
 * one task, not three.
 */
function entrySlugOf(filename: string): string | null {
  // `parseTypedFilename` strips the extension without checking it, so an editor backup
  // (`doc.index.{id}.md~`) parses exactly like the entry it shadows. `listCollectionEntries`
  // additionally requires a CONFIGURED format extension, so it skips those -- and this must skip
  // them too, or the guard refuses a write over a file the build guard never counted.
  if (!CONTENT_EXTENSIONS.some((ext) => filename.endsWith(ext))) return null
  return parseTypedFilename(filename)?.slug ?? null
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

    // A collection literally NAMED "index" collapses onto ITS OWN path (`<parentPath>/index`),
    // not onto `<parentPath>` -- see `computeEntryUrl`. So the only thing that could contest it
    // is another entry in the parent whose slug is ALSO the literal string "index" -- but per
    // that same forward rule, such an entry IS the parent's own index/landing entry, which
    // collapses onto `<parentPath>` itself, a different URL. Nothing in the parent can ever claim
    // `<parentPath>/index`, so skip the lookup below rather than let it match the parent's own
    // index entry and report a collision that does not exist. Without this, a collection named
    // "index" could never have a landing page under any parent that has one of its own --
    // ironic, since `resolveUrlPathCandidates`' candidate 2 was deliberately engineered to keep a
    // collection named "index" addressable in the first place.
    if (isIndexSlug(ownName)) return null

    const claimant = await findEntryBySlugIn(parentDir, ownName)
    return claimant ? { kind: 'parent-entry', physicalPath: claimant, name: ownName } : null
  }

  // A plain entry sits at the same URL as a same-named child collection's index entry.
  //
  // KNOWN DEPENDENCY: this resolves ONE child collection by name, and the index direction above
  // likewise looks only for a parent ENTRY. Neither considers a second collection sharing the
  // same name, because nothing currently stops one being created -- `createCollectionInner` does
  // not check sibling names at all (tracked in collection-sibling-name-uniqueness.md). With two
  // `guides.{id}` directories side by side you can write an index entry into each, and both
  // writes pass this guard while two entries end up claiming one URL. The build guard still
  // catches it. Fixing sibling-name uniqueness closes this without changing anything here --
  // which is why that task is a prerequisite for this guard being complete, not an unrelated
  // tidy-up.
  const childDir = await findChildCollectionDir(collectionDir, slug)
  if (!childDir) return null
  const indexEntry = await findIndexEntryIn(childDir)
  return indexEntry
    ? { kind: 'sibling-collection-index', physicalPath: indexEntry, name: slug }
    : null
}
