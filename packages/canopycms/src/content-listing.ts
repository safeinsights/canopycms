/**
 * Shared content-listing utilities used by both the entries API and the content tree builder.
 *
 * Extracted from api/entries.ts to avoid duplication.
 */

import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import matter from 'gray-matter'
import { parse as yamlParse } from 'yaml'

import type { ContentFormat, FlatSchemaItem, EntryTypeConfig, EntrySchema } from './config'
import { findBodyFieldName } from './utils/body-field'
import { computeEntryUrl } from './utils/entry-url'
import { asRecord, getFormatExtension } from './utils/format'
import { resolveCollectionPath } from './content-id-index'
import { validateAndNormalizePath } from './paths'
import { isNotFoundError, getErrorMessage } from './utils/error'
import { createDebugLogger } from './utils/debug'
import type { LogicalPath, PhysicalPath, Slug, ContentId } from './paths/types'
import {
  ContentStore,
  ContentStoreError,
  createReferenceResolveCache,
  type ReferenceResolveCache,
} from './content-store'
import { isBuildMode } from './build-mode'

const log = createDebugLogger({ prefix: 'ContentListing' })

/**
 * An entry listing item with raw data from the filesystem.
 * Does not include API-specific fields like canEdit.
 */
export interface CollectionListItem {
  logicalPath: LogicalPath
  contentId: ContentId
  slug: Slug
  collectionPath: LogicalPath
  collectionName: string
  format: ContentFormat
  entryType: string
  physicalPath: PhysicalPath
  /** Raw entry data (frontmatter + body for md/mdx, parsed data for json/yaml) */
  data: Record<string, unknown>
  updatedAt?: string
}

/**
 * Validate and normalize a path relative to root.
 * Throws ContentStoreError on traversal attempt.
 */
const normalizePath = (root: string, target: string): string => {
  const result = validateAndNormalizePath(root, target)
  if (!result.valid) {
    throw new ContentStoreError(result.error || 'Path traversal detected', 'VALIDATION')
  }
  return result.normalizedPath!
}

/**
 * Read entry data from a file.
 * For md/mdx: returns frontmatter fields plus the body content (mapped to the
 * field name specified by `bodyFieldName`, which defaults to `'body'`).
 * For json: returns the parsed JSON object.
 * Returns an empty object on read/parse failure.
 */
export const readEntryData = async (
  filePath: string,
  format: ContentFormat,
  bodyFieldName = 'body',
): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    if (format === 'json') {
      return asRecord(JSON.parse(raw))
    }
    if (format === 'yaml') {
      return asRecord(yamlParse(raw))
    }
    const parsed = matter(raw)
    // Copy before writing the body in. gray-matter keeps a PROCESS-GLOBAL cache keyed by file
    // content and hands every caller the same `data` object instance, so mutating it in place
    // wrote the body into a shared object that later, unrelated `matter()` calls then saw as
    // frontmatter. Concretely, before this copy: listing a collection that contains an md entry
    // poisoned the cache, and a subsequent reference resolution to that same entry — which goes
    // through `ContentStore.read()`, whose md branch calls `matter()` again — returned the body
    // as a frontmatter field. So a resolved md snippet came back WITH `body` on a whole-site
    // listing and WITHOUT it on one scoped past its own collection: the same entry, two shapes,
    // decided by unrelated scoping. Regression coverage lives with the reference-resolution
    // tests in content-listing.test.ts.
    const data = { ...((parsed.data as Record<string, unknown>) ?? {}) }
    if (parsed.content) {
      data[bodyFieldName] = parsed.content
    }
    return data
  } catch (err: unknown) {
    if (isNotFoundError(err)) return {}
    log.warn('readEntryData', `Failed to read entry data from ${filePath}: ${getErrorMessage(err)}`)
    return {}
  }
}

// `parseTypedFilename` now lives in utils/typed-filename.ts so dependency-light modules can
// use it without importing this one (which pulls in ContentStore). Re-exported here because
// this is where callers -- and `canopycms/server` -- have always imported it from.
export { parseTypedFilename } from './utils/typed-filename'
import { parseTypedFilename } from './utils/typed-filename'

// ---------------------------------------------------------------------------
// Batch listing types and function
// ---------------------------------------------------------------------------

/**
 * A flat entry item from listEntries.
 * Structural metadata is always present; `data` is controlled by the extract option.
 */
export interface ListEntriesItem<T = Record<string, unknown>> {
  /** URL path segments, e.g., ['researchers', 'guides', 'glossary-of-terms'] */
  pathSegments: string[]
  /**
   * URL-ready path with index entries collapsed to their parent collection path.
   * For index entries: '/guides' instead of '/guides/index'.
   * For regular entries: '/guides/glossary-of-terms'.
   * For a root index entry: '/'.
   *
   * Round-trip safe: `readByUrlPath(item.urlPath)` resolves to the same entry. That guarantee
   * depends on `slug` passing `parseSlug` — the filename grammar (`utils/typed-filename.ts`)
   * allows a slug to contain characters `parseSlug` rejects (a dot, most commonly), and an entry
   * whose slug does is listed here same as any other but can never be read back by URL.
   * `static/index.ts`'s `assertRoutableSlugs` is the build-time guard that catches this outside
   * this doc comment's promise.
   */
  urlPath: string
  /** Entry slug within its collection */
  slug: Slug
  /** Logical CMS path for this entry */
  entryPath: LogicalPath
  /** Entry's content ID (12-char Base58 from filename) */
  entryId: ContentId
  /** Collection's content ID (12-char Base58 from directory name) */
  collectionId?: ContentId
  /** Collection logical path */
  collectionPath: LogicalPath
  /** Entry type name */
  entryType: string
  /** Content format */
  format: ContentFormat
  /**
   * Entry data. Without extract: full raw data (frontmatter + body for md/mdx, parsed data for json/yaml).
   * With extract: whatever the extract function returns.
   */
  data: T
  /** Field definitions for this entry's type, when resolvable. */
  schema?: EntrySchema
  /**
   * Filesystem mtime (ISO 8601) of the entry file, from an unconditional `fs.stat`
   * done while listing. Caveat: this is a checkout-time timestamp, not an editorial
   * one — a fresh CI clone resets every file's mtime to checkout time, so treat this
   * as "changed since last build" at best, not an authoritative last-edited date for
   * a public-facing `<lastmod>`. Sourcing mtime from git commit history is a
   * separate, not-yet-built improvement.
   */
  updatedAt?: string
}

export interface ListEntriesOptions<T = Record<string, unknown>> {
  /**
   * Transform raw entry data. Controls what ends up in `data` on each result.
   * Raw data includes all frontmatter fields; for md/mdx, raw.body is the markdown content.
   * Without extract, data is the full raw object.
   */
  extract?: (
    raw: Record<string, unknown>,
    meta: { entryPath: LogicalPath; entryType: string; format: ContentFormat },
  ) => T
  /**
   * Filter entries. Return false to exclude.
   * Runs after extract, so data is the transformed value.
   */
  filter?: (entry: ListEntriesItem<T>) => boolean
  /** Starting collection path. Defaults to content root.
   * Efficiency: skips loading entries outside this scope. */
  rootPath?: string
  /** Custom sort. */
  sort?: (a: ListEntriesItem<T>, b: ListEntriesItem<T>) => number
  /**
   * Resolve `reference` fields to the referenced entry's data, the way
   * `read()`/`readByUrlPath()` do — including references nested inside `object` fields,
   * inline `group`s and block templates (so a shared/referenced block finally carries its
   * snippet's content here). Off leaves them as the bare id string, or `null`.
   *
   * **Defaults to `false`, unlike `read()`, which defaults to `true`.** The asymmetry is
   * deliberate rather than an oversight. `data` is `T` and `extract` receives an untyped
   * `Record<string, unknown>`, so turning this on changes a reference from `'a1b2c3d4e5f6'`
   * to `{ ...data, id, slug, collection, urlPath }` with no compile error anywhere to catch it — an
   * `/authors/${data.author}` template silently becomes `/authors/[object Object]`. Opting
   * in is a decision you make per call site, next to the code that reads the field. It also
   * keeps the common batch uses free: `collectStaticPaths` discards `data` outright, and
   * `build/generate-ai-content.ts` lists purely to validate entry shapes.
   *
   * **Cost, and why it is bounded.** Resolution needs a `ContentStore` and its ContentId
   * index, so turning it on adds one index scan per call plus one read per DISTINCT
   * referenced entry — not per referencing entry. A single {@link ReferenceResolveCache}
   * spans the whole call, so a shared block referenced by 40 pages is read once, not 40
   * times. Nothing is constructed and nothing is scanned when this is off.
   *
   * **Path ACLs are not applied to the resolved targets**, matching `read()` exactly: a
   * reference can resolve to an entry the user could not `read()` directly. The entries
   * being LISTED are still ACL-filtered as always, and a filtered-out entry is never
   * resolved at all.
   */
  resolveReferences?: boolean
}

/**
 * Server-only path-ACL predicate, applied to raw entries before any of their data
 * reaches a caller.
 *
 * Deliberately NOT part of `ListEntriesOptions`/`BuildContentTreeOptions`: those are
 * adopter-facing, and adopter code must not be able to supply, widen, or override the
 * access check. `context.ts` is the only intended producer — it builds the predicate
 * from `services.createContentAccessChecker` for the request-scoped user, and omits it
 * entirely at build time / on static deployments (synthetic admin, no ACLs).
 *
 * Omitting it preserves the pre-existing unfiltered behavior exactly, which is what
 * build-time callers want.
 */
export interface ContentVisibilityOptions {
  /** Return false to drop an entry. Receives the entry's branch-root-relative physical path. */
  shouldInclude?: (physicalPath: PhysicalPath) => boolean
}

/** A collection node from the flattened schema. */
export type CollectionSchemaItem = Extract<FlatSchemaItem, { type: 'collection' }>

// ---------------------------------------------------------------------------
// Reference resolution for batch listings
// ---------------------------------------------------------------------------

/**
 * Build the `ContentStore` + shared cache that a batch listing resolves references through.
 *
 * Unrelated to the `ReferenceResolver` class in reference-resolver.ts despite the adjacent
 * name — that one resolves an id to a human-readable *display label* for the editor UI. This
 * resolves a reference to the referenced entry's *data* for server-side listings.
 *
 * Constructed lazily by each listing surface, and ONLY when the caller opted in — a store
 * builds a ContentId index on first use, which is a full scan of the content tree, and the
 * default (`resolveReferences` off) must stay a pure filesystem walk with no index at all.
 *
 * One store and one cache per listing call, not per collection: the cache is the reason a
 * shared block referenced from 40 pages costs one read instead of 40, so it has to span the
 * whole batch. Per-call construction is the established shape here — content-reader.ts's
 * `resolveStore` builds a store per read, and content-index-registry.ts holds stores through
 * `WeakRef` + a `FinalizationRegistry` precisely so short-lived instances stay collectable.
 */
export const createReferenceResolver = (
  branchRoot: string,
  flatSchema: FlatSchemaItem[],
  contentRootName: string,
): { store: ContentStore; cache: ReferenceResolveCache } => ({
  store: new ContentStore(branchRoot, flatSchema, { contentRootName }),
  cache: createReferenceResolveCache(),
})

/**
 * Resolve `reference` fields in a collection's listed entries, in place of their raw data.
 *
 * Shared by `listEntries` and `buildContentTree` so both opt into resolution through one
 * implementation. Each entry resolves against its OWN entry type's field list, since that is
 * what says which fields are references at all; an entry whose type has no resolvable schema
 * is returned untouched rather than guessed at.
 */
export const resolveCollectionItemReferences = async (
  items: CollectionListItem[],
  collection: CollectionSchemaItem,
  resolver: { store: ContentStore; cache: ReferenceResolveCache },
): Promise<CollectionListItem[]> =>
  Promise.all(
    items.map(async (item) => {
      const fields = collection.entries?.find((e) => e.name === item.entryType)?.schema
      if (!fields) return item
      return {
        ...item,
        data: await resolver.store.resolveReferences(item.data, fields, resolver.cache),
      }
    }),
  )

/**
 * List all content entries as a flat array.
 *
 * Walks the schema to discover collections, reads entries from each,
 * and returns a flat list suitable for generateStaticParams, search indexing, sitemaps, etc.
 *
 * Build-time-only failure: a file with a recognized content extension (`.md`/`.mdx`/`.json`/
 * `.yaml`) sitting in a collection directory that *looks like an attempted entry* (see
 * `looksLikeMalformedEntry` below) but doesn't match `{type}.{slug}.{id}.{ext}` is, by default,
 * silently dropped (see `listCollectionEntries`'s debug-gated warning). That is exactly the
 * silent-page-loss failure mode static generation must not have — a schema rename without a
 * matching file rename, or an entry type declared in one collection but not another, would
 * otherwise vanish a page with zero build output. So when `isBuildMode()` is true, any such file
 * turns the listing into a thrown error instead (see `findInvalidEntries`/`assertBuildEntriesValid`
 * in `static/index.ts` for the sibling schema-validity guard this mirrors). Outside build mode
 * (admin UI, content tree, `next dev`) the file is still just skipped, since a fresh scaffold or
 * mid-rename file legitimately exists there.
 *
 * A file that was never entry-shaped to begin with — a `README.md`, or a colocated sibling
 * artifact named `{contentId}.suffix.ext` per the `entryTransforms`/`readSibling` convention
 * documented in the README — is not this guard's failure mode and never throws, in or out of
 * build mode. See `looksLikeMalformedEntry` for the exact shape test.
 *
 * @param branchRoot - Absolute path to the branch workspace root
 * @param flatSchema - Flattened schema items (from flattenSchema)
 * @param contentRootName - The content root name (e.g. "content")
 * @param options - Listing options (extract, filter, rootPath, sort, resolveReferences)
 * @param visibility - Internal path-ACL predicate; see `ContentVisibilityOptions`
 */
export async function listEntries<T = Record<string, unknown>>(
  branchRoot: string,
  flatSchema: FlatSchemaItem[],
  contentRootName: string,
  options?: ListEntriesOptions<T>,
  visibility?: ContentVisibilityOptions,
): Promise<ListEntriesItem<T>[]> {
  const rootPath = options?.rootPath ?? contentRootName
  const extract = options?.extract
  const filter = options?.filter
  const customSort = options?.sort

  // Find all collections under rootPath
  const collections = flatSchema.filter(
    (item): item is CollectionSchemaItem =>
      item.type === 'collection' &&
      item.entries !== undefined &&
      (item.logicalPath === rootPath || item.logicalPath.startsWith(`${rootPath}/`)),
  )

  // List entries from all collections in parallel.
  // The visibility predicate is applied here, before the map below, so a denied entry's
  // data never reaches `extract` (let alone the returned items).
  const shouldInclude = visibility?.shouldInclude
  const skippedFiles: SkippedListingFile[] = []
  // One store + cache for the whole call, or nothing at all when the caller did not opt in.
  // See the `resolveReferences` option for the cost this buys back.
  const resolver = options?.resolveReferences
    ? createReferenceResolver(branchRoot, flatSchema, contentRootName)
    : null
  const collectionResults = await Promise.all(
    collections.map(async (collection) => {
      const entries = await listCollectionEntries(branchRoot, collection, (file) =>
        skippedFiles.push(file),
      )
      const visible = shouldInclude ? entries.filter((e) => shouldInclude(e.physicalPath)) : entries
      // Resolve AFTER the visibility filter (a denied entry is never resolved, so its
      // references cost nothing and leak nothing) and BEFORE the mapping below, so
      // `extract` and `filter` both see resolved data — which is the entire point.
      const resolved = resolver
        ? await resolveCollectionItemReferences(visible, collection, resolver)
        : visible
      return resolved.map((entry) => ({ entry, collection }))
    }),
  )

  // Build-time only: fail loudly rather than silently shipping a build with a page missing. See
  // the build-time-only-failure note in this function's own doc comment above. Only files that
  // structurally look like a malformed entry reach `skippedFiles` at all -- see
  // `looksLikeMalformedEntry` and `listCollectionEntries`.
  if (isBuildMode() && skippedFiles.length > 0) {
    const lines = skippedFiles.map(
      ({ filename, collectionPath }) => `  - ${collectionPath}/${filename}`,
    )
    throw new Error(
      `CanopyCMS static build: found ${skippedFiles.length} file(s) that look like malformed ` +
        `content entries inside a content collection:\n${lines.join('\n')}\n` +
        'Expected {type}.{slug}.{id}.{ext} with a known entry type (a name declared in that ' +
        "collection's entries config) and a valid 12-char Base58 ID. This usually means a schema " +
        'rename without a matching file rename, an entry type declared in one collection but not ' +
        'another, or a stray file placed directly in a collection directory. If this is meant to ' +
        "be a colocated sibling artifact (e.g. an entry's contentId-prefixed data file read via " +
        'an entryTransforms readSibling call), keep its name to three or fewer dot-separated ' +
        'segments (id.suffix.ext) so it is never mistaken for an entry attempt. Otherwise rename ' +
        'or move the file, or fix the schema, then rebuild.',
    )
  }

  // Flatten and map to ListEntriesItem
  const contentPrefix = contentRootName ? `${contentRootName}/` : ''
  const items: ListEntriesItem<T>[] = []

  for (const results of collectionResults) {
    for (const { entry, collection } of results) {
      // Compute pathSegments: strip content root prefix, split on /
      const pathWithoutRoot = entry.logicalPath.startsWith(contentPrefix)
        ? entry.logicalPath.slice(contentPrefix.length)
        : entry.logicalPath
      const pathSegments = pathWithoutRoot.split('/').filter(Boolean)

      // Compute urlPath (collapses an `index` entry to its parent collection path) through
      // the SHARED rule rather than a local copy of it. A resolved reference now carries a
      // `urlPath` too, and the whole point of that field is that it addresses the same entry
      // this listing does, so the two must not be free to drift apart.
      //
      // One deliberate copy of this rule remains: `content-tree.ts`'s `defaultBuildPath`,
      // which is exported for adopters to extend and also handles the collection case
      // `computeEntryUrl` does not model. It agrees today; folding it in is tracked in
      // `.claude/future-tasks/default-build-path-url-rule-copy.md`.
      // `content-listing.test.ts` pins the listing-vs-resolved-reference agreement.
      const urlPath = computeEntryUrl(entry.collectionPath, entry.slug, contentRootName)

      const raw = entry.data
      const meta = {
        entryPath: entry.logicalPath,
        entryType: entry.entryType,
        format: entry.format,
      }
      const data = extract ? extract(raw, meta) : (raw as T)

      const item: ListEntriesItem<T> = {
        pathSegments,
        urlPath,
        slug: entry.slug,
        entryPath: entry.logicalPath,
        entryId: entry.contentId,
        collectionId: collection.contentId,
        collectionPath: entry.collectionPath,
        entryType: entry.entryType,
        format: entry.format,
        data,
        schema: collection.entries?.find((e) => e.name === entry.entryType)?.schema,
        updatedAt: entry.updatedAt,
      }

      if (filter && !filter(item)) continue
      items.push(item)
    }
  }

  if (customSort) {
    items.sort(customSort)
  } else {
    // Default: sort by entryPath for deterministic output across runs
    items.sort((a, b) => a.entryPath.localeCompare(b.entryPath))
  }

  return items
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Sort items by a content ID order array.
 * Items in the order array come first (in order), items not in the array come at the end
 * sorted by the provided fallback key.
 *
 * Note: sorts the array in-place and returns it.
 */
export const sortByOrder = <T extends { contentId?: ContentId }>(
  items: T[],
  order: readonly string[] | undefined,
  fallbackKey: (item: T) => string,
): T[] => {
  if (!order || order.length === 0) {
    return items.sort((a, b) => fallbackKey(a).localeCompare(fallbackKey(b)))
  }

  const orderMap = new Map<string, number>()
  order.forEach((id, index) => orderMap.set(id, index))

  return items.sort((a, b) => {
    const aIndex = a.contentId ? orderMap.get(a.contentId) : undefined
    const bIndex = b.contentId ? orderMap.get(b.contentId) : undefined

    if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex
    if (aIndex !== undefined) return -1
    if (bIndex !== undefined) return 1

    return fallbackKey(a).localeCompare(fallbackKey(b))
  })
}

/** A content-extension file inside a collection directory whose filename didn't parse. */
export interface SkippedListingFile {
  /** The bare filename, e.g. `article.lost-page.4fBqT78gcaLd.md`. */
  filename: string
  /** The collection's logical path. */
  collectionPath: LogicalPath
}

/**
 * True when a content-extension filename structurally resembles an attempted entry — as opposed
 * to a file that was never entry-shaped to begin with.
 *
 * A successfully-parsed entry always has at least 4 dot-separated segments: `type` (1+),
 * `slug` (1+, since `parseTypedFilename` always takes at least the one segment between type and
 * id), `id` (1), `ext` (1). So a file with 4+ segments that still failed to parse is malformed
 * on its face — a wrong-length or invalid-Base58 ID, most often (`post.hello-world.BADID.md`).
 *
 * That segment-count test alone missed the MORE common accident: losing the ID segment
 * entirely. `post.hello-world.md` (3 segments) fails `parseTypedFilename` exactly like the
 * 4-segment case does, but a bare 3-or-fewer-segment cutoff would treat it as never having been
 * entry-shaped and drop it silently — the page just vanishes with a green build. So a 3-segment
 * file whose FIRST segment matches a real entry type name in this collection is ALSO treated as
 * malformed: `parseTypedFilename` requires type+slug+id (3 segments) after stripping the
 * extension, so a 3-total-segment filename already has only 2 left over — it could only have
 * been attempting `type.slug` with no id, or `type.id` with no slug, either way a lost segment,
 * not a coincidence. This still leaves the two motivating "was never an entry" cases alone: a
 * bare `README.md` (2 segments, and "README" is essentially never a configured entry type name)
 * and an entry's colocated sibling artifact named `{contentId}.suffix.ext` per the
 * `entryTransforms`/`readSibling` convention documented in the README (3 segments, e.g.
 * `5NVkkrB1MJUv.profile.json` — a content ID is never itself an entry type name, so the same
 * "first segment matches a known type" test correctly leaves it unflagged).
 *
 * Dot-prefixed (hidden files, editor swap/backup files) and underscore-prefixed (a common
 * adopter convention for "not an entry") names are excluded outright regardless of segment
 * count, matching `parseTypedFilename`'s own dotfile rejection.
 */
const looksLikeMalformedEntry = (
  filename: string,
  entryTypes: readonly EntryTypeConfig[],
): boolean => {
  if (filename.startsWith('.') || filename.startsWith('_')) return false
  const segments = filename.split('.')
  if (segments.length >= 4) return true
  return segments.length === 3 && entryTypes.some((e) => e.name === segments[0])
}

/**
 * List all entries in a collection directory.
 * Reads each entry's data (frontmatter or JSON).
 *
 * @param onSkip - Called for every file that has a recognized content extension, doesn't match
 *   the `{type}.{slug}.{id}.{ext}` grammar (see `parseTypedFilename`), AND structurally looks
 *   like an attempted entry (see `looksLikeMalformedEntry`). A file that was never entry-shaped
 *   (too few dot-separated segments to ever be a valid entry — a `README.md`, a colocated
 *   sibling artifact) is always silently dropped with a debug-gated `log.warn`, never passed to
 *   `onSkip`. Optional and purely a diagnostic hook — existing callers that omit it keep the
 *   exact prior behavior. `listEntries` below uses this to turn the skip into a hard build-time
 *   failure instead of a silent one.
 */
export const listCollectionEntries = async (
  root: string,
  collection: FlatSchemaItem,
  onSkip?: (file: SkippedListingFile) => void,
): Promise<CollectionListItem[]> => {
  if (collection.type !== 'collection' || !collection.entries) {
    return []
  }

  const entryTypes = collection.entries as readonly EntryTypeConfig[]

  // Build a map of extension to entry types for efficient lookup
  const extToTypes = new Map<string, EntryTypeConfig[]>()
  for (const entryType of entryTypes) {
    const ext = getFormatExtension(entryType.format)
    const existing = extToTypes.get(ext) || []
    existing.push(entryType)
    extToTypes.set(ext, existing)
  }

  const validExts = Array.from(extToTypes.keys())

  // Resolve the full collection path with embedded IDs
  const collectionRoot = await resolveCollectionPath(root, collection.logicalPath)
  if (!collectionRoot) {
    return []
  }

  normalizePath(root, collectionRoot)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(collectionRoot, { withFileTypes: true })
  } catch (err: unknown) {
    if (isNotFoundError(err)) return []
    throw err
  }

  const files = dirents
    .filter(
      (d) =>
        d.isFile() &&
        validExts.some((ext) => d.name.endsWith(ext)) &&
        d.name !== '.collection.json',
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  const entries = await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(collectionRoot, file.name)
      const relativePath = normalizePath(root, absolutePath)

      const parsed = parseTypedFilename(file.name, entryTypes)
      if (!parsed) {
        log.warn(
          'listCollectionEntries',
          `Skipping file with unrecognized filename format: ${file.name} (expected {type}.{slug}.{id}.{ext} with a known entry type and valid 12-char Base58 ID)`,
        )
        if (looksLikeMalformedEntry(file.name, entryTypes)) {
          onSkip?.({ filename: file.name, collectionPath: collection.logicalPath })
        }
        return null
      }

      const { type: entryTypeName, slug, id: contentId } = parsed
      const entryType = entryTypes.find((e) => e.name === entryTypeName)
      const format: ContentFormat = entryType?.format || 'json'
      const bodyField = entryType?.schema ? findBodyFieldName(entryType.schema) : 'body'

      const [stats, data] = await Promise.all([
        fs.stat(absolutePath),
        readEntryData(absolutePath, format, bodyField),
      ])

      const item: CollectionListItem = {
        logicalPath: `${collection.logicalPath}/${slug}` as LogicalPath,
        contentId,
        slug,
        collectionPath: collection.logicalPath,
        collectionName: collection.name,
        format,
        entryType: entryTypeName,
        physicalPath: relativePath as PhysicalPath,
        data,
        updatedAt: stats.mtime.toISOString(),
      }
      return item
    }),
  )

  return entries.filter((e): e is CollectionListItem => e !== null)
}
