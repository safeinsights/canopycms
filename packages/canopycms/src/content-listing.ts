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
import { isNotFoundError } from './utils/error'
import { isValidId } from './id'
import type { LogicalPath, PhysicalPath, EntrySlug, ContentId } from './paths/types'
import { ContentStoreError } from './content-store'

/**
 * An entry listing item with raw data from the filesystem.
 * Does not include API-specific fields like canEdit.
 */
export interface CollectionListItem {
  logicalPath: LogicalPath
  contentId: ContentId
  slug: EntrySlug
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
 * Read frontmatter (md/mdx) or full JSON data from an entry file.
 * Returns an empty object on read/parse failure.
 */
export const readEntryData = async (
  filePath: string,
  format: ContentFormat,
): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    if (format === 'json') {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return parsed
    }
    const parsed = matter(raw)
    return (parsed.data as Record<string, unknown>) ?? {}
  } catch {
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
): { type: string; slug: EntrySlug; id: ContentId } | null => {
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
      const slug = parts.slice(1, -1).join('.')
      return {
        type: potentialType,
        slug: slug as EntrySlug,
        id: id as ContentId,
      }
    }
  }

  return null
}

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
        console.warn(
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
