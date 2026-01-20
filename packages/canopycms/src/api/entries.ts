import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import matter from 'gray-matter'

import type { FieldConfig, ContentFormat, FlatSchemaItem, EntryTypeConfig } from '../config'
import { ContentStoreError } from '../content-store'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import { getFormatExtension } from '../utils/format'
import { resolveCollectionPath } from '../content-id-index'
import { validateAndNormalizePath, normalizeFilesystemPath } from '../paths'
import { isNotFoundError } from '../utils/error'

type CollectionKind = 'collection' | 'entry'

export interface EntryCollectionSummary {
  id: string
  name: string
  label?: string
  path: string
  format: ContentFormat
  type: CollectionKind
  schema: readonly FieldConfig[]
  parentId?: string
  children?: EntryCollectionSummary[]
}

export interface CollectionItem {
  id: string
  slug: string
  collectionId: string
  collectionName: string
  format: ContentFormat
  entryType: string // The entry type name (from typed entries)
  path: string
  title?: string
  updatedAt?: string
  exists?: boolean
  canEdit?: boolean
}

export interface ListEntriesParams {
  branch: string
  collection?: string
  limit?: number
  cursor?: string
  q?: string
  recursive?: boolean
}

export interface ListEntriesResponse {
  collections: EntryCollectionSummary[]
  entries: CollectionItem[]
  pagination: {
    cursor?: string
    hasMore: boolean
    limit: number
  }
}

/** Response type for listing entries */
export type EntriesResponse = ApiResponse<ListEntriesResponse>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const listEntriesParamsSchema = z.object({
  branch: z.string().min(1),
  collection: z.string().optional(),
  limit: z.number().optional(),
  cursor: z.string().optional(),
  q: z.string().optional(),
  recursive: z.boolean().optional(),
})

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

const readTitle = async (filePath: string, format: ContentFormat): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    if (format === 'json') {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const title = parsed.title ?? parsed.name
      return typeof title === 'string' ? title : undefined
    }
    const parsed = matter(raw)
    const frontmatterTitle = (parsed.data as any)?.title ?? (parsed.data as any)?.name
    return typeof frontmatterTitle === 'string' ? frontmatterTitle : undefined
  } catch {
    return undefined
  }
}

/**
 * Get the default entry type from a collection's entries array.
 * Returns the entry marked as default, or the first one, or undefined if no entries.
 */
const getDefaultEntryType = (entries: readonly EntryTypeConfig[] | undefined): EntryTypeConfig | undefined => {
  if (!entries || entries.length === 0) return undefined
  return entries.find(e => e.default) || entries[0]
}

/**
 * Parse a filename: {type}.{slug}.{id}.{ext}
 * Returns { type, slug, id } or null if the filename doesn't match the pattern.
 */
const parseTypedFilename = (filename: string, entryTypes: readonly EntryTypeConfig[]): { type?: string; slug: string; id?: string } | null => {
  // Remove extension
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1) return null
  const nameWithoutExt = filename.slice(0, lastDot)

  // Parse: {type}.{slug}.{id}
  const parts = nameWithoutExt.split('.')
  if (parts.length >= 3) {
    // Check if first part matches a known entry type
    const potentialType = parts[0]
    const matchingType = entryTypes.find(e => e.name === potentialType)
    if (matchingType) {
      const id = parts[parts.length - 1]
      const slug = parts.slice(1, -1).join('.')
      return { type: potentialType, slug, id }
    }
  }

  return null
}

const listCollectionEntries = async (
  root: string,
  collection: FlatSchemaItem
): Promise<CollectionItem[]> => {
  // Only collections with entries can be listed
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

  // Get all valid extensions for this collection
  const validExts = Array.from(extToTypes.keys())

  // Resolve the full collection path with embedded IDs
  // e.g., "content/docs/api" → "content/docs.bChqT78gcaLd/api.meiuwxTSo7UN"
  const collectionRoot = await resolveCollectionPath(root, collection.fullPath)

  if (!collectionRoot) {
    // Collection directory doesn't exist yet
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

  // Filter to files with valid extensions
  const files = dirents
    .filter((d) => d.isFile() && validExts.some(ext => d.name.endsWith(ext)) && d.name !== '.collection.json')
    .sort((a, b) => a.name.localeCompare(b.name))

  // Parallelize file stats and title reads for better performance
  const entries = await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(collectionRoot, file.name)
      const relativePath = normalizePath(root, absolutePath)

      // Parse the filename to extract type, slug, and id
      const parsed = parseTypedFilename(file.name, entryTypes)
      if (!parsed) return null

      const { type: entryTypeName, slug } = parsed

      // Determine the entry type and format
      let entryType: EntryTypeConfig | undefined
      let format: ContentFormat

      // Type is always in filename now
      entryType = entryTypes.find(e => e.name === entryTypeName)
      format = entryType?.format || 'json'

      const [stats, title] = await Promise.all([
        fs.stat(absolutePath),
        readTitle(absolutePath, format),
      ])

      const item: CollectionItem = {
        id: `${collection.fullPath}/${slug}`,
        slug,
        collectionId: collection.fullPath,
        collectionName: collection.name,
        format,
        entryType: entryTypeName || 'default',
        path: relativePath,
        title: title ?? entryType?.label, // Fall back to entry type label if no title in content
        updatedAt: stats.mtime.toISOString(),
        exists: true,
      }
      return item
    })
  )

  // Filter out nulls from failed parses
  return entries.filter((e): e is CollectionItem => e !== null)
}

/**
 * List entries from a collection and all its nested child collections
 */
const listCollectionEntriesRecursive = async (
  root: string,
  targetPath: string,
  flatCollections: FlatSchemaItem[]
): Promise<CollectionItem[]> => {
  // Find all collections that are descendants of the target path
  const descendants = flatCollections.filter(item => {
    return item.fullPath === targetPath || item.fullPath.startsWith(`${targetPath}/`)
  })

  // Parallelize listing entries from all descendant collections
  const collectionsWithEntries = descendants.filter(
    (item) => item.type === 'collection' && item.entries
  )
  const results = await Promise.all(
    collectionsWithEntries.map((item) => listCollectionEntries(root, item))
  )

  return results.flat()
}

/** Normalize a collection ID for consistent comparison */
const normalizeCollectionId = (value: string): string => normalizeFilesystemPath(value)

/**
 * Build collection summaries from flat schema items.
 * Only includes collections - entry types are schema metadata and not included as summaries.
 */
const buildCollectionSummaries = (
  flatCollections: FlatSchemaItem[],
  targetId?: string
): EntryCollectionSummary[] => {
  // Filter to target collection and its descendants if targetId is provided
  const filtered = targetId
    ? flatCollections.filter(item =>
        item.fullPath === targetId || item.fullPath.startsWith(`${targetId}/`)
      )
    : flatCollections

  // Filter to collections only and convert to summaries
  return filtered
    .filter(item => item.type === 'collection')
    .map(item => {
      // Get default entry type for the collection summary
      const entryTypes = item.entries as readonly EntryTypeConfig[] | undefined
      const defaultEntry = getDefaultEntryType(entryTypes)
      return {
        id: item.fullPath,
        name: item.name,
        label: item.label,
        path: item.fullPath,
        format: defaultEntry?.format || 'json',
        type: 'collection' as const,
        schema: defaultEntry?.fields || [],
        parentId: item.parentPath,
      }
    })
}

export const listEntriesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof listEntriesParamsSchema>
): Promise<EntriesResponse> => {
  if (!params.branch) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const root = context.branchRoot
  const flatCollections = ctx.services.flatSchema

  const targetId = params.collection ? normalizeCollectionId(params.collection) : undefined
  let targetCollections = flatCollections

  if (targetId) {
    const match = flatCollections.find((c) => c.fullPath === targetId)
    if (!match) {
      return { ok: false, status: 404, error: 'Collection not found' }
    }
    targetCollections = [match]
  }

  const maxLimit = 200
  const limit = Math.min(Math.max(params.limit ?? 50, 1), maxLimit)
  const offset = Number.isFinite(Number(params.cursor)) ? Number(params.cursor) : 0
  const search = params.q?.toLowerCase()
  const recursive = params.recursive ?? false

  const entries: CollectionItem[] = []

  if (recursive && targetId) {
    // Recursive mode: list entries from target collection and all its children
    try {
      const items = await listCollectionEntriesRecursive(root, targetId, flatCollections)
      items.sort((a, b) => a.slug.localeCompare(b.slug))
      for (const item of items) {
        // Use the path already included in the item
        const readAccess = await ctx.services.checkContentAccess(context, root, item.path, req.user, 'read')
        if (!readAccess.allowed) continue
        const editAccess = await ctx.services.checkContentAccess(context, root, item.path, req.user, 'edit')
        if (search) {
          const haystack = `${item.slug} ${item.title ?? ''} ${item.collectionName ?? ''}`.toLowerCase()
          if (!haystack.includes(search)) {
            continue
          }
        }
        entries.push({ ...item, canEdit: editAccess.allowed })
      }
    } catch (err) {
      if (err instanceof ContentStoreError) {
        return { ok: false, status: 400, error: err.message }
      }
      throw err
    }
  } else {
    // Non-recursive mode: list entries from target collections
    for (const item of targetCollections) {
      // Only process collections (skip entry-types as they are metadata, not navigable nodes)
      if (item.type !== 'collection') continue

      try {
        const items = await listCollectionEntries(root, item)
        items.sort((a, b) => a.slug.localeCompare(b.slug))
        for (const entry of items) {
          // Use the path already included in the item
          const readAccess = await ctx.services.checkContentAccess(context, root, entry.path, req.user, 'read')
          if (!readAccess.allowed) continue
          const editAccess = await ctx.services.checkContentAccess(context, root, entry.path, req.user, 'edit')
          if (search) {
            const haystack = `${entry.slug} ${entry.title ?? ''} ${entry.collectionName ?? ''}`.toLowerCase()
            if (!haystack.includes(search)) {
              continue
            }
          }
          entries.push({ ...entry, canEdit: editAccess.allowed })
        }
      } catch (err) {
        if (err instanceof ContentStoreError) {
          return { ok: false, status: 400, error: err.message }
        }
        throw err
      }
    }
  }

  const paged = entries.slice(offset, offset + limit)
  const nextCursor = offset + limit < entries.length ? String(offset + limit) : undefined

  const collections = buildCollectionSummaries(flatCollections, targetId)

  return {
    ok: true,
    status: 200,
    data: {
      collections,
      entries: paged,
      pagination: {
        cursor: nextCursor,
        hasMore: Boolean(nextCursor),
        limit,
      },
    },
  }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * List entries for a branch
 * GET /:branch/entries
 */
export const listEntries = defineEndpoint({
  namespace: 'entries',
  name: 'list',
  method: 'GET',
  path: '/:branch/entries',
  params: listEntriesParamsSchema,
  responseType: 'EntriesResponse',
  response: {} as EntriesResponse,
  defaultMockData: {
    collections: [],
    entries: [],
    pagination: {
      hasMore: false,
      limit: 50,
    },
  },
  handler: listEntriesHandler,
})

/**
 * Exported routes for router registration
 */
export const ENTRY_ROUTES = {
  list: listEntries,
} as const
