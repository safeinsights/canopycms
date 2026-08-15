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
import { asRecord, getFormatExtension } from './utils/format'
import { resolveCollectionPath } from './content-id-index'
import { validateAndNormalizePath } from './paths'
import { isNotFoundError, getErrorMessage } from './utils/error'
import { createDebugLogger } from './utils/debug'
import { isValidId } from './id'
import type { LogicalPath, PhysicalPath, Slug, ContentId } from './paths/types'
import { ContentStoreError } from './content-store'
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
    const data = (parsed.data as Record<string, unknown>) ?? {}
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

/**
 * Parse a Canopy content filename into its `{type}.{slug}.{id}.{ext}` parts.
 *
 * ## Filename grammar
 *
 * Every entry file on disk is named `{type}.{slug}.{id}.{ext}`:
 * - `type` — the entry type name (a key in the collection's `entries` config).
 * - `slug` — the entry's URL slug. May itself contain dots (e.g. a slug of
 *   `getting.started.guide`), so the type and ID anchor the split: the ID is
 *   always the second-to-last dot-separated segment, and the slug is
 *   everything between the type and the ID. The returned `slug` is
 *   lowercased.
 * - `id` — a 12-character Base58 content ID (`generateId()`/`isValidId()`).
 *   Base58 excludes the ambiguous characters `0`, `O`, `I`, `l` so IDs are
 *   unambiguous when read aloud or hand-transcribed. A filename whose
 *   would-be ID segment doesn't pass `isValidId` is rejected — the whole
 *   parse returns `null`, even if the rest of the shape looks right.
 * - `ext` — the format extension (`.md`, `.mdx`, `.json`, `.yaml`), stripped
 *   before parsing and not part of the returned result.
 *
 * @param filename - The bare filename (no directory component). **This precondition is
 *   not enforced.** The parser splits purely on `.`, so a `/` or `\` you pass in is not
 *   rejected and is not treated as special — it becomes part of whichever segment it
 *   falls in, most often the `type` segment (e.g. `'foo/bar.slug.<validId>.md'` parses
 *   to `type: 'foo/bar'`). Strip any directory component yourself (e.g.
 *   `path.basename(filePath)`) before calling this — every internal caller already does.
 * @param entryTypes - When provided, the parsed `type` segment must match one
 *   of these entry types by name, or the parse is rejected (this is how
 *   `listCollectionEntries` filters out files that don't belong to the
 *   collection's configured entry types). Omit this argument to parse
 *   structurally without validating the type against a known list — useful
 *   for adopter code that needs to recover `{type, slug, id}` from a
 *   filename without having a schema/entry-types list on hand (e.g. a
 *   filesystem walk over content for tooling or diagnostics). Even without
 *   `entryTypes`, a leading-dot filename (dotfile, editor swap/backup file)
 *   is always rejected — an empty string is never a legal type, matching the
 *   `filename.startsWith('.')` guard `extractEntryTypeFromFilename` in
 *   `content-id-index.ts` already applies.
 * @returns `{ type, slug, id }`, or `null` if `filename` doesn't match the
 *   `{type}.{slug}.{id}.{ext}` shape (too few segments, no extension, a
 *   leading dot, an invalid ID, or — when `entryTypes` is given — an
 *   unrecognized type). `id` is validated (`isValidId`) and safe to trust. **`slug` is
 *   not** — it is the raw dot-joined middle segment(s), lowercased, cast to the branded
 *   `Slug` type without running `parseSlug`'s validation. A filename with an
 *   unconventional slug segment (e.g. containing a space) still parses and still
 *   receives the `Slug` brand. Callers that need a validated slug must run the result
 *   through `parseSlug` themselves; this function's contract is "split the filename
 *   grammar apart," not "validate every part."
 */
export const parseTypedFilename = (
  filename: string,
  entryTypes?: readonly EntryTypeConfig[],
): { type: string; slug: Slug; id: ContentId } | null => {
  // Reject dotfiles outright (matching extractEntryTypeFromFilename's guard in
  // content-id-index.ts): a leading dot can never be a legal entry type, and this
  // is exactly the shape of the files a structural (no-entryTypes) parse would
  // otherwise misparse -- e.g. '.hidden.file.aB3cD4eF5gH6.md' -> potentialType ''.
  if (filename.startsWith('.')) return null

  // Remove extension
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1) return null
  const nameWithoutExt = filename.slice(0, lastDot)

  // Parse: {type}.{slug}.{id}
  const parts = nameWithoutExt.split('.')
  if (parts.length < 3) return null

  const potentialType = parts[0]
  // When a known-types list is supplied, the first segment must match one of
  // them. Without it, any non-empty first segment is accepted as the type.
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
   * Round-trip safe: `readByUrlPath(item.urlPath)` resolves to the same entry.
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
 * @param options - Listing options (extract, filter, rootPath, sort)
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
    (item): item is Extract<FlatSchemaItem, { type: 'collection' }> =>
      item.type === 'collection' &&
      item.entries !== undefined &&
      (item.logicalPath === rootPath || item.logicalPath.startsWith(`${rootPath}/`)),
  )

  // List entries from all collections in parallel.
  // The visibility predicate is applied here, before the map below, so a denied entry's
  // data never reaches `extract` (let alone the returned items).
  const shouldInclude = visibility?.shouldInclude
  const skippedFiles: SkippedListingFile[] = []
  const collectionResults = await Promise.all(
    collections.map(async (collection) => {
      const entries = await listCollectionEntries(branchRoot, collection, (file) =>
        skippedFiles.push(file),
      )
      const visible = shouldInclude ? entries.filter((e) => shouldInclude(e.physicalPath)) : entries
      return visible.map((entry) => ({ entry, collection }))
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

      // Compute urlPath: collapse index entries to parent collection path
      const urlSegments = entry.slug === 'index' ? pathSegments.slice(0, -1) : pathSegments
      const urlPath = urlSegments.length > 0 ? `/${urlSegments.join('/')}`.toLowerCase() : '/'

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
 * id), `id` (1), `ext` (1). So a file with 3 or fewer dot-separated segments could never have
 * parsed as an entry regardless of its content — it isn't a malformed entry, it's a different
 * kind of file that happens to share a recognized extension. The two motivating cases: a bare
 * `README.md` (2 segments) and an entry's colocated sibling artifact named
 * `{contentId}.suffix.ext` per the `entryTransforms`/`readSibling` convention documented in the
 * README (3 segments, e.g. `5NVkkrB1MJUv.profile.json`).
 *
 * Dot-prefixed (hidden files, editor swap/backup files) and underscore-prefixed (a common
 * adopter convention for "not an entry") names are excluded outright regardless of segment
 * count, matching `parseTypedFilename`'s own dotfile rejection.
 */
const looksLikeMalformedEntry = (filename: string): boolean => {
  if (filename.startsWith('.') || filename.startsWith('_')) return false
  return filename.split('.').length >= 4
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
        if (looksLikeMalformedEntry(file.name)) {
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
