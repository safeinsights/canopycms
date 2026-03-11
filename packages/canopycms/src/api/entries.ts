import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import matter from 'gray-matter'

import type { FieldConfig, ContentFormat, FlatSchemaItem, EntryTypeConfig } from '../config'
import { ContentStore, ContentStoreError } from '../content-store'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import { getFormatExtension } from '../utils/format'
import { resolveCollectionPath } from '../content-id-index'
import { validateAndNormalizePath, normalizeFilesystemPath, toLogicalPath, toPhysicalPath, toEntrySlug } from '../paths'
import { isNotFoundError } from '../utils/error'
import type { LogicalPath, PhysicalPath } from '../paths/types'
import { branchNameSchema, logicalPathSchema } from './validators'


type CollectionKind = 'collection' | 'entry'

/**
 * Summary of an entry type for client display.
 * Simplified from EntryTypeConfig - doesn't include full field definitions.
 */
export interface EntryTypeSummary {
  name: string
  label?: string
  format: ContentFormat
  default?: boolean
  maxItems?: number
}

export interface EntryCollectionSummary {
  logicalPath: LogicalPath
  contentId: string // 12-char content ID
  name: string
  label?: string
  format: ContentFormat // Default entry type's format (for backwards compatibility)
  type: CollectionKind
  schema: readonly FieldConfig[] // Default entry type's schema (for backwards compatibility)
  entryTypes?: EntryTypeSummary[] // All entry types in this collection
  order?: readonly string[] // Embedded IDs for ordering items
  parentId?: string
  children?: EntryCollectionSummary[]
}

export interface CollectionItem {
  logicalPath: LogicalPath
  contentId: string // 12-char content ID
  slug: string
  collectionId: string
  collectionName: string
  format: ContentFormat
  entryType: string // The entry type name (from typed entries)
  physicalPath: PhysicalPath
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
  branch: branchNameSchema,
  collection: logicalPathSchema.optional(),
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
 * Sort entries by the collection's order array.
 * Items in the order array come first (in order), items not in the array come at the end alphabetically by slug.
 * @param entries - The entries to sort
 * @param order - The order array (embedded IDs)
 * @returns Sorted entries
 */
const sortEntriesByOrder = (entries: CollectionItem[], order?: readonly string[]): CollectionItem[] => {
  if (!order || order.length === 0) {
    // No order defined, sort alphabetically by slug
    return entries.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  // Create a map of contentId to order index
  const orderMap = new Map<string, number>()
  order.forEach((id, index) => orderMap.set(id, index))

  return entries.sort((a, b) => {
    const aIndex = orderMap.get(a.contentId)
    const bIndex = orderMap.get(b.contentId)

    // Both in order array: sort by order index
    if (aIndex !== undefined && bIndex !== undefined) {
      return aIndex - bIndex
    }

    // Only a is in order: a comes first
    if (aIndex !== undefined) return -1

    // Only b is in order: b comes first
    if (bIndex !== undefined) return 1

    // Neither in order: sort alphabetically by slug
    return a.slug.localeCompare(b.slug)
  })
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
  const collectionRoot = await resolveCollectionPath(root, collection.logicalPath)

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

      const { type: entryTypeName, slug, id: contentId } = parsed

      // contentId must be present (all entries have IDs in filenames)
      if (!contentId) {
        console.warn(`Entry missing contentId in filename: ${file.name}`)
        return null
      }

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
        logicalPath: toLogicalPath(`${collection.logicalPath}/${slug}`),
        contentId, // 12-char content ID extracted from filename
        slug,
        collectionId: collection.logicalPath,
        collectionName: collection.name,
        format,
        entryType: entryTypeName || 'default',
        physicalPath: toPhysicalPath(relativePath),
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
    return item.logicalPath === targetPath || item.logicalPath.startsWith(`${targetPath}/`)
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

export const listEntriesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof listEntriesParamsSchema>
): Promise<EntriesResponse> => {
  if (!params.branch) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const root = context.branchRoot
  const flatSchema = context.flatSchema!
  const flatCollections = flatSchema

  const targetId = params.collection ? normalizeCollectionId(params.collection) : undefined
  let targetCollections = flatCollections

  if (targetId) {
    const match = flatCollections.find((c) => c.logicalPath === targetId)
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
      // For recursive mode, we can't easily apply per-collection ordering
      // Sort alphabetically for now (ordering is collection-specific)
      items.sort((a, b) => a.slug.localeCompare(b.slug))
      for (const item of items) {
        // Use the physicalPath for access control
        const readAccess = await ctx.services.checkContentAccess(context, root, item.physicalPath, req.user, 'read')
        if (!readAccess.allowed) continue
        const editAccess = await ctx.services.checkContentAccess(context, root, item.physicalPath, req.user, 'edit')
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
        // Sort by collection's order array (items in order first, then alphabetically)
        sortEntriesByOrder(items, item.order)
        for (const entry of items) {
          // Use the physicalPath for access control
          const readAccess = await ctx.services.checkContentAccess(context, root, entry.physicalPath, req.user, 'read')
          if (!readAccess.allowed) continue
          const editAccess = await ctx.services.checkContentAccess(context, root, entry.physicalPath, req.user, 'edit')
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

  return {
    ok: true,
    status: 200,
    data: {
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

// ============================================================================
// Delete Entry
// ============================================================================

/** Response type for deleting an entry */
export type DeleteEntryResponse = ApiResponse<{ deleted: boolean; contentId?: string }>

const deleteEntryParamsSchema = z.object({
  branch: branchNameSchema,
  entryPath: logicalPathSchema, // Format: collectionPath/slug
})

/**
 * Delete an entry and update the collection's order array.
 * DELETE /:branch/entries/...entryPath
 * Note: Uses catch-all to support paths with slashes (e.g., content/posts/hello-world)
 */
const deleteEntryHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof deleteEntryParamsSchema>
): Promise<DeleteEntryResponse> => {
  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Parse entryPath to get collection and slug
  // Format: collectionPath/slug (e.g., "posts/hello-world" or "docs/api/getting-started")
  const entryPath = decodeURIComponent(params.entryPath)
  const lastSlash = entryPath.lastIndexOf('/')
  if (lastSlash === -1) {
    return { ok: false, status: 400, error: 'Invalid entry path format. Expected: collectionPath/slug' }
  }

  const collectionPath = entryPath.slice(0, lastSlash)
  const slug = entryPath.slice(lastSlash + 1)

  if (!collectionPath || !slug) {
    return { ok: false, status: 400, error: 'Invalid entry path format. Expected: collectionPath/slug' }
  }

  const flatSchema = context.flatSchema!

  // Check edit permission on the entry
  // Build the physical path for permission check
  const collection = flatSchema.find(
    (item) => item.type === 'collection' && item.logicalPath === collectionPath
  )
  if (!collection) {
    return { ok: false, status: 404, error: 'Collection not found' }
  }

  // Check edit access
  const editAccess = await ctx.services.checkContentAccess(
    context,
    context.branchRoot,
    toPhysicalPath(`${collectionPath}/${slug}`),
    req.user,
    'edit'
  )
  if (!editAccess.allowed) {
    return { ok: false, status: 403, error: 'Edit permission required to delete entry' }
  }

  try {
    // Get the entry's content ID before deleting (for order update)
    const contentStore = new ContentStore(context.branchRoot, flatSchema)
    const contentId = await contentStore.getIdForEntry(toLogicalPath(collectionPath), toEntrySlug(slug))

    // Delete the entry
    await contentStore.delete(toLogicalPath(collectionPath), toEntrySlug(slug))

    // Update the collection's order array to remove the deleted item
    if (contentId && collection.type === 'collection' && collection.order) {
      const { SchemaStore } = await import('../schema/schema-store')
      const schemaStore = new SchemaStore(context.branchRoot, ctx.services.schemaRegistry)
      const newOrder = collection.order.filter((id) => id !== contentId)
      if (newOrder.length !== collection.order.length) {
        await schemaStore.updateOrder(collectionPath as LogicalPath, newOrder as string[])
      }
    }

    return {
      ok: true,
      status: 200,
      data: { deleted: true, contentId: contentId || undefined },
    }
  } catch (err) {
    if (isNotFoundError(err)) {
      return { ok: false, status: 404, error: 'Entry not found' }
    }
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : 'Failed to delete entry',
    }
  }
}

/**
 * Delete an entry
 * DELETE /:branch/entries/...entryPath
 * Note: Uses catch-all to support paths with slashes (e.g., content/posts/hello-world)
 */
export const deleteEntry = defineEndpoint({
  namespace: 'entries',
  name: 'delete',
  method: 'DELETE',
  path: '/:branch/entries/...entryPath',
  params: deleteEntryParamsSchema,
  responseType: 'DeleteEntryResponse',
  response: {} as DeleteEntryResponse,
  defaultMockData: { deleted: true },
  handler: deleteEntryHandler,
})

/**
 * Exported routes for router registration
 */
export const ENTRY_ROUTES = {
  list: listEntries,
  delete: deleteEntry,
} as const
