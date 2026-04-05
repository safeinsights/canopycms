/**
 * Shared content-listing utilities used by both the entries API and the content tree builder.
 *
 * Extracted from api/entries.ts to avoid duplication.
 */

import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import matter from 'gray-matter'

import type { ContentFormat, FlatSchemaItem, EntryTypeConfig } from './config'
import { getFormatExtension } from './utils/format'
import { resolveCollectionPath } from './content-id-index'
import { validateAndNormalizePath } from './paths'
import { isNotFoundError, getErrorMessage } from './utils/error'
import { createDebugLogger } from './utils/debug'
import { isValidId } from './id'

const log = createDebugLogger({ prefix: 'ContentListing' })
import type { LogicalPath, PhysicalPath, Slug, ContentId } from './paths/types'
import { ContentStoreError } from './content-store'

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
  /** Raw entry data (frontmatter for md/mdx, parsed JSON for json) */
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
    throw new ContentStoreError(result.error || 'Path traversal detected')
  }
  return result.normalizedPath!
}

/**
 * Read entry data from a file.
 * For md/mdx: returns frontmatter fields plus `body` (the markdown content).
 * For json: returns the parsed JSON object.
 * Returns an empty object on read/parse failure.
 */
export const readEntryData = async (
  filePath: string,
  format: ContentFormat,
): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    if (format === 'json') {
      return JSON.parse(raw) as Record<string, unknown>
    }
    const parsed = matter(raw)
    const data = (parsed.data as Record<string, unknown>) ?? {}
    if (parsed.content) {
      data.body = parsed.content
    }
    return data
  } catch (err: unknown) {
    log.warn('readEntryData', `Failed to read entry data from ${filePath}: ${getErrorMessage(err)}`)
    return {}
  }
}

/**
 * Parse a filename: {type}.{slug}.{id}.{ext}
 * Returns { type, slug, id } or null if the filename doesn't match the pattern.
 */
export const parseTypedFilename = (
  filename: string,
  entryTypes: readonly EntryTypeConfig[],
): { type: string; slug: Slug; id: ContentId } | null => {
  // Remove extension
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1) return null
  const nameWithoutExt = filename.slice(0, lastDot)

  // Parse: {type}.{slug}.{id}
  const parts = nameWithoutExt.split('.')
  if (parts.length >= 3) {
    // Check if first part matches a known entry type
    const potentialType = parts[0]
    const matchingType = entryTypes.find((e) => e.name === potentialType)
    if (matchingType) {
      const id = parts[parts.length - 1]
      if (!isValidId(id)) return null
      const slug = parts.slice(1, -1).join('.').toLowerCase()
      return {
        type: potentialType,
        slug: slug as Slug,
        id: id as ContentId,
      }
    }
  }

  return null
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
   * Entry data. Without extract: full raw data (frontmatter + body for md/mdx, JSON fields for json).
   * With extract: whatever the extract function returns.
   */
  data: T
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
 * List all content entries as a flat array.
 *
 * Walks the schema to discover collections, reads entries from each,
 * and returns a flat list suitable for generateStaticParams, search indexing, sitemaps, etc.
 *
 * @param branchRoot - Absolute path to the branch workspace root
 * @param flatSchema - Flattened schema items (from flattenSchema)
 * @param contentRootName - The content root name (e.g. "content")
 * @param options - Listing options (extract, filter, rootPath, sort)
 */
export async function listEntries<T = Record<string, unknown>>(
  branchRoot: string,
  flatSchema: FlatSchemaItem[],
  contentRootName: string,
  options?: ListEntriesOptions<T>,
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

  // List entries from all collections in parallel
  const collectionResults = await Promise.all(
    collections.map(async (collection) => {
      const entries = await listCollectionEntries(branchRoot, collection)
      return entries.map((entry) => ({ entry, collection }))
    }),
  )

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

      const raw = entry.data
      const meta = {
        entryPath: entry.logicalPath,
        entryType: entry.entryType,
        format: entry.format,
      }
      const data = extract ? extract(raw, meta) : (raw as T)

      const item: ListEntriesItem<T> = {
        pathSegments,
        slug: entry.slug,
        entryPath: entry.logicalPath,
        entryId: entry.contentId,
        collectionId: collection.contentId,
        collectionPath: entry.collectionPath,
        entryType: entry.entryType,
        format: entry.format,
        data,
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

/**
 * List all entries in a collection directory.
 * Reads each entry's data (frontmatter or JSON).
 */
export const listCollectionEntries = async (
  root: string,
  collection: FlatSchemaItem,
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
        return null
      }

      const { type: entryTypeName, slug, id: contentId } = parsed
      const entryType = entryTypes.find((e) => e.name === entryTypeName)
      const format: ContentFormat = entryType?.format || 'json'

      const [stats, data] = await Promise.all([
        fs.stat(absolutePath),
        readEntryData(absolutePath, format),
      ])

      const item: CollectionListItem = {
        logicalPath: `${collection.logicalPath}/${slug}` as LogicalPath,
        contentId,
        slug,
        collectionPath: collection.logicalPath,
        collectionName: collection.name,
        format,
        entryType: entryTypeName || 'default',
        physicalPath: relativePath as PhysicalPath,
        data,
        updatedAt: stats.mtime.toISOString(),
      }
      return item
    }),
  )

  return entries.filter((e): e is CollectionListItem => e !== null)
}
