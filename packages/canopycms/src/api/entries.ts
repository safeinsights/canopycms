import { z } from 'zod'

import type { ContentFormat, EntryTypeConfig, FlatSchemaItem } from '../config'
import { ContentStore, ContentStoreError } from '../content-store'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContextWithSchema } from '../types'
import { defineEndpoint } from './route-builder'
import { normalizeFilesystemPath, parseSlug, parseLogicalPath } from '../paths'
import { isNotFoundError } from '../utils/error'
import { resolveEntryTitle } from '../utils/title-field'
import type { LogicalPath, PhysicalPath, Slug, ContentId } from '../paths/types'
import { branchNameSchema, logicalPathSchema, queryBooleanSchema } from './validators'
import { MAX_ENTRIES_PER_PAGE, DEFAULT_ENTRIES_LIMIT } from './entries-constants'
import { SchemaOps } from '../schema/schema-store'
import {
  listCollectionEntries as listCollectionEntriesShared,
  sortByOrder,
  type CollectionListItem,
} from '../content-listing'
import type { ContentAccessChecker } from '../authorization'

// Re-export pagination constants from the dependency-free module so they remain
// part of the entries API surface without pulling server deps into client bundles.
export { MAX_ENTRIES_PER_PAGE, DEFAULT_ENTRIES_LIMIT } from './entries-constants'

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

export interface CollectionItem {
  logicalPath: LogicalPath
  contentId: ContentId // 12-char content ID
  slug: Slug
  collectionPath: LogicalPath
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
  collection?: LogicalPath
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
  // GET query params arrive as strings — coerce instead of rejecting them
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional(),
  q: z.string().optional(),
  recursive: queryBooleanSchema.optional(),
})

/** Extract a display title from entry data using the centralized fallback chain. */
const extractTitle = (
  data: Record<string, unknown>,
  entryType?: EntryTypeConfig,
  slug?: string,
): string =>
  resolveEntryTitle(data, {
    schema: entryType?.schema,
    entryTypeLabel: entryType?.label,
    slug,
  })

/** Map a CollectionListItem to the API's CollectionItem type. */
const toCollectionItem = (
  entry: CollectionListItem,
  collection: FlatSchemaItem,
): CollectionItem => {
  const entryType =
    collection.type === 'collection'
      ? collection.entries?.find((e) => e.name === entry.entryType)
      : undefined
  return {
    logicalPath: entry.logicalPath,
    contentId: entry.contentId,
    slug: entry.slug,
    collectionPath: entry.collectionPath,
    collectionName: entry.collectionName,
    format: entry.format,
    entryType: entry.entryType,
    physicalPath: entry.physicalPath,
    title: extractTitle(entry.data, entryType, entry.slug),
    updatedAt: entry.updatedAt,
    exists: true,
  }
}

/** List entries in a single collection, mapped to API CollectionItem type. */
const listCollectionEntries = async (
  root: string,
  collection: FlatSchemaItem,
): Promise<CollectionItem[]> => {
  const entries = await listCollectionEntriesShared(root, collection)
  return entries.map((entry) => toCollectionItem(entry, collection))
}

/**
 * List entries from a collection and all its nested child collections
 */
const listCollectionEntriesRecursive = async (
  root: string,
  targetPath: string,
  flatCollections: FlatSchemaItem[],
): Promise<CollectionItem[]> => {
  const descendants = flatCollections.filter((item) => {
    return item.logicalPath === targetPath || item.logicalPath.startsWith(`${targetPath}/`)
  })

  const collectionsWithEntries = descendants.filter(
    (item) => item.type === 'collection' && item.entries,
  )
  const results = await Promise.all(
    collectionsWithEntries.map((item) => listCollectionEntries(root, item)),
  )

  return results.flat()
}

/**
 * Apply access control and search filtering to a list of entries.
 *
 * Uses a pre-built batch checker (see `createContentAccessChecker`) so permissions
 * are loaded once per request, not per entry. The read + edit checks are now cheap
 * synchronous calls.
 */
const filterWithAccessControl = (
  items: CollectionItem[],
  checkAccess: ContentAccessChecker,
  search: string | undefined,
): CollectionItem[] => {
  const results: CollectionItem[] = []
  for (const item of items) {
    const readAccess = checkAccess(item.physicalPath, 'read')
    if (!readAccess.allowed) continue
    const editAccess = checkAccess(item.physicalPath, 'edit')
    if (search) {
      const haystack = `${item.slug} ${item.title ?? ''} ${item.collectionName ?? ''}`.toLowerCase()
      if (!haystack.includes(search)) continue
    }
    results.push({ ...item, canEdit: editAccess.allowed })
  }
  return results
}

const listEntriesHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof listEntriesParamsSchema>,
): Promise<EntriesResponse> => {
  if (!params.branch) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  const { branchContext } = gc
  const root = branchContext.branchRoot
  const flatSchema = branchContext.flatSchema
  const flatCollections = flatSchema

  const targetPath = params.collection ? normalizeFilesystemPath(params.collection) : undefined
  let targetCollections = flatCollections

  if (targetPath) {
    const match = flatCollections.find((c) => c.logicalPath === targetPath)
    if (!match) {
      return { ok: false, status: 404, error: 'Collection not found' }
    }
    targetCollections = [match]
  }

  const limit = Math.min(Math.max(params.limit ?? DEFAULT_ENTRIES_LIMIT, 1), MAX_ENTRIES_PER_PAGE)
  // Offset-based pagination: items may be skipped or duplicated if content changes between pages.
  const offset = Number.isFinite(Number(params.cursor)) ? Number(params.cursor) : 0
  const search = params.q?.toLowerCase()
  const recursive = params.recursive ?? false

  let entries: CollectionItem[] = []

  try {
    // Build the access checker once per request: permissions (and, in modes with a
    // separate settings branch, the settings workspace) are loaded a single time and
    // reused for every entry, instead of re-loading per entry inside the loop.
    const checkAccess = await ctx.services.createContentAccessChecker(branchContext, root, req.user)

    if (recursive && targetPath) {
      // Recursive mode: list entries from target collection and all its children
      const items = await listCollectionEntriesRecursive(root, targetPath, flatCollections)
      // For recursive mode, we can't easily apply per-collection ordering
      // Sort alphabetically for now (ordering is collection-specific)
      items.sort((a, b) => a.slug.localeCompare(b.slug))
      entries = filterWithAccessControl(items, checkAccess, search)
    } else {
      // Non-recursive mode: list entries from target collections. Collections are
      // listed in parallel (mirrors the shared listEntries in content-listing.ts);
      // Promise.all preserves array order, so entry ordering matches a serial loop.
      const collections = targetCollections.filter((item) => item.type === 'collection')
      const perCollection = await Promise.all(
        collections.map(async (item) => {
          const items = await listCollectionEntries(root, item)
          // Sort by collection's order array (items in order first, then alphabetically)
          sortByOrder(items, item.order, (i) => i.slug)
          return filterWithAccessControl(items, checkAccess, search)
        }),
      )
      entries = perCollection.flat()
    }
  } catch (err) {
    if (err instanceof ContentStoreError) {
      return { ok: false, status: 400, error: err.message }
    }
    throw err
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
    entries: [],
    pagination: {
      hasMore: false,
      limit: DEFAULT_ENTRIES_LIMIT,
    },
  },
  guards: ['schema'] as const,
  handler: listEntriesHandler,
})

// ============================================================================
// Delete Entry
// ============================================================================

/** Response type for deleting an entry */
export type DeleteEntryResponse = ApiResponse<{
  deleted: boolean
  contentId?: string
}>

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
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof deleteEntryParamsSchema>,
): Promise<DeleteEntryResponse> => {
  const { branchContext } = gc

  // Parse entryPath to get collection and slug
  // Format: collectionPath/slug (e.g., "posts/hello-world" or "docs/api/getting-started")
  // Re-validate after decoding to prevent double-encoding path traversal attacks
  const decoded = decodeURIComponent(params.entryPath)
  const entryPathResult = parseLogicalPath(decoded)
  if (!entryPathResult.ok) {
    return {
      ok: false,
      status: 400,
      error: `Invalid entry path: ${entryPathResult.error}`,
    }
  }
  const entryPath = entryPathResult.path

  const lastSlash = entryPath.lastIndexOf('/')
  if (lastSlash === -1) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid entry path format. Expected: collectionPath/slug',
    }
  }

  const collectionPath = entryPath.slice(0, lastSlash)
  const slug = entryPath.slice(lastSlash + 1)

  if (!collectionPath || !slug) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid entry path format. Expected: collectionPath/slug',
    }
  }

  const flatSchema = branchContext.flatSchema

  // Check edit permission on the entry
  // Build the physical path for permission check
  const collection = flatSchema.find(
    (item) => item.type === 'collection' && item.logicalPath === collectionPath,
  )
  if (!collection) {
    return { ok: false, status: 404, error: 'Collection not found' }
  }

  const contentStore = new ContentStore(branchContext.branchRoot, flatSchema)
  const collectionLogicalPath = collectionPath as LogicalPath
  // Validate slug extracted from the path
  const slugResult = parseSlug(slug)
  if (!slugResult.ok) {
    return {
      ok: false,
      status: 400,
      error: `Invalid entry slug: ${slugResult.error}`,
    }
  }
  const entrySlug = slugResult.slug

  // Resolve the real physical path before checking permissions
  let physicalPath: PhysicalPath
  try {
    const resolved = await contentStore.resolveDocumentPath(collectionLogicalPath, entrySlug)
    physicalPath = resolved.relativePath
  } catch (err) {
    if (isNotFoundError(err)) {
      return { ok: false, status: 404, error: 'Entry not found' }
    }
    return { ok: false, status: 400, error: 'Invalid entry path' }
  }

  // Check edit access using the real physical path
  const editAccess = await ctx.services.checkContentAccess(
    branchContext,
    branchContext.branchRoot,
    physicalPath,
    req.user,
    'edit',
  )
  if (!editAccess.allowed) {
    return {
      ok: false,
      status: 403,
      error: 'Edit permission required to delete entry',
    }
  }

  try {
    // Get the entry's content ID before deleting (for order update)
    const contentId = await contentStore.getIdForEntry(collectionLogicalPath, entrySlug)

    // Delete the entry
    await contentStore.delete(collectionLogicalPath, entrySlug)

    // Update the collection's order array to remove the deleted item
    if (contentId && collection.type === 'collection' && collection.order) {
      const schemaStore = new SchemaOps(branchContext.branchRoot, ctx.services.entrySchemaRegistry)
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
  guards: ['schema'] as const,
  handler: deleteEntryHandler,
})

/**
 * Exported routes for router registration
 */
export const ENTRY_ROUTES = {
  list: listEntries,
  delete: deleteEntry,
} as const
