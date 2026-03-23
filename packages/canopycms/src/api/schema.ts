/**
 * Schema API - endpoints for managing collection structure.
 *
 * Provides CRUD operations for:
 * - Collections (create, read, update, delete)
 * - Entry types (add, update, remove)
 * - Ordering (update item order within collections)
 *
 * All mutations require Admin group membership.
 * Schema changes are branch-specific (like content edits).
 */

import { z } from 'zod'
import path from 'node:path'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import { isAdmin } from '../authorization/helpers'
import { getErrorMessage } from '../utils/error'
import { branchNameSchema, logicalPathSchema } from './validators'
import { guardBranchAccess, isBranchAccessError } from './middleware'
import {
  SchemaOps,
  createCollectionInputSchema,
  updateCollectionInputSchema,
  entryTypeInputSchema,
  updateEntryTypeInputSchema,
  type CreateCollectionInput,
  type UpdateCollectionInput,
  type CreateEntryTypeInput,
  type UpdateEntryTypeInput,
} from '../schema/schema-store'
import type {
  CollectionConfig,
  EntryTypeConfig,
  FlatSchemaItem,
  ContentFormat,
  EntrySchema,
} from '../config'
import { type LogicalPath, type ContentId, parseLogicalPath } from '../paths'

// ============================================================================
// Wire Types — API response shapes with schemaRef instead of resolved schema
// ============================================================================

/** Entry type in wire format: schemaRef instead of resolved schema */
export interface WireEntryType {
  readonly name: string
  readonly format: ContentFormat
  readonly schemaRef: string
  readonly label?: string
  readonly default?: boolean
  readonly maxItems?: number
}

/** Collection in wire format (entry types carry schemaRef, not resolved schema) */
export interface WireCollectionConfig {
  readonly name: string
  readonly path: string
  readonly label?: string
  readonly entries?: readonly WireEntryType[]
  readonly collections?: readonly WireCollectionConfig[]
  readonly order?: readonly string[]
}

/** Flat schema item in wire format */
export type WireFlatSchemaItem =
  | {
      type: 'collection'
      logicalPath: LogicalPath
      name: string
      label?: string
      contentId?: ContentId
      parentPath?: LogicalPath
      entries?: readonly WireEntryType[]
      collections?: readonly WireCollectionConfig[]
      order?: readonly string[]
    }
  | {
      type: 'entry-type'
      logicalPath: LogicalPath
      name: string
      label?: string
      parentPath: LogicalPath
      format: ContentFormat
      schemaRef: string
      default?: boolean
      maxItems?: number
    }

// ============================================================================
// Wire conversion functions
// ============================================================================

type Registry = Record<string, EntrySchema>

/**
 * Resolve the schemaRef for an entry type. Uses the explicit schemaRef if set,
 * otherwise does a reverse lookup in the registry by matching the schema array.
 */
function resolveSchemaRef(et: EntryTypeConfig, registry: Registry): string {
  if (et.schemaRef) return et.schemaRef
  // Reverse lookup: find which registry key maps to this entry type's schema
  for (const [key, value] of Object.entries(registry)) {
    if (value === et.schema) return key
  }
  throw new Error(
    `Cannot resolve schemaRef for entry type "${et.name}". ` +
      `No matching entry found in the entry schema registry. ` +
      `This may indicate a stale schema cache — try invalidating it.`,
  )
}

function toWireEntryType(et: EntryTypeConfig, registry: Registry): WireEntryType {
  return {
    name: et.name,
    format: et.format,
    schemaRef: resolveSchemaRef(et, registry),
    ...(et.label !== undefined && { label: et.label }),
    ...(et.default !== undefined && { default: et.default }),
    ...(et.maxItems !== undefined && { maxItems: et.maxItems }),
  }
}

function toWireCollection(col: CollectionConfig, registry: Registry): WireCollectionConfig {
  return {
    name: col.name,
    path: col.path,
    ...(col.label !== undefined && { label: col.label }),
    ...(col.entries && {
      entries: col.entries.map((et) => toWireEntryType(et, registry)),
    }),
    ...(col.collections && {
      collections: col.collections.map((c) => toWireCollection(c, registry)),
    }),
    ...(col.order && { order: col.order }),
  }
}

function toWireFlatSchema(items: FlatSchemaItem[], registry: Registry): WireFlatSchemaItem[] {
  return items.map((item): WireFlatSchemaItem => {
    if (item.type === 'collection') {
      return {
        type: 'collection',
        logicalPath: item.logicalPath,
        name: item.name,
        ...(item.label !== undefined && { label: item.label }),
        ...(item.contentId !== undefined && { contentId: item.contentId }),
        ...(item.parentPath !== undefined && { parentPath: item.parentPath }),
        ...(item.entries && {
          entries: item.entries.map((et) => toWireEntryType(et, registry)),
        }),
        ...(item.collections && {
          collections: item.collections.map((c) => toWireCollection(c, registry)),
        }),
        ...(item.order && { order: item.order }),
      }
    }
    return {
      type: 'entry-type',
      logicalPath: item.logicalPath,
      name: item.name,
      ...(item.label !== undefined && { label: item.label }),
      parentPath: item.parentPath,
      format: item.format,
      schemaRef: resolveSchemaRef(item, registry),
      ...(item.default !== undefined && { default: item.default }),
      ...(item.maxItems !== undefined && { maxItems: item.maxItems }),
    }
  })
}

// ============================================================================
// Response Types
// ============================================================================

export interface SchemaResponse {
  flatSchema: WireFlatSchemaItem[]
  /** Entry schema definitions keyed by registry name */
  entrySchemas: Record<string, EntrySchema>
}

export interface EntryTypeWithUsage {
  name: string
  label?: string
  format: ContentFormat
  schemaRef: string
  default?: boolean
  maxItems?: number
  /** Number of entries using this entry type (for locking validation) */
  usageCount: number
}

export interface CollectionResponse {
  collection: WireCollectionConfig | null
  /** Entry types with usage counts (only present when collection exists) */
  entryTypesWithUsage?: EntryTypeWithUsage[]
}

export interface CreateCollectionResponse {
  /** The logical path to the created collection (e.g., "posts" or "blog/posts") */
  collectionPath: LogicalPath
  /** The unique 12-character content ID for the collection */
  contentId: ContentId
}

export interface UpdateCollectionResponse {
  success: boolean
}

export interface DeleteCollectionResponse {
  success: boolean
}

export interface AddEntryTypeResponse {
  success: boolean
}

export interface UpdateEntryTypeResponse {
  success: boolean
}

export interface RemoveEntryTypeResponse {
  success: boolean
}

export interface UpdateOrderResponse {
  success: boolean
}

export interface InvalidateSchemaCacheResponse {
  success: boolean
  message: string
}

export type GetSchemaApiResponse = ApiResponse<SchemaResponse>
export type GetCollectionApiResponse = ApiResponse<CollectionResponse>
export type CreateCollectionApiResponse = ApiResponse<CreateCollectionResponse>
export type UpdateCollectionApiResponse = ApiResponse<UpdateCollectionResponse>
export type DeleteCollectionApiResponse = ApiResponse<DeleteCollectionResponse>
export type AddEntryTypeApiResponse = ApiResponse<AddEntryTypeResponse>
export type UpdateEntryTypeApiResponse = ApiResponse<UpdateEntryTypeResponse>
export type RemoveEntryTypeApiResponse = ApiResponse<RemoveEntryTypeResponse>
export type UpdateOrderApiResponse = ApiResponse<UpdateOrderResponse>
export type InvalidateSchemaCacheApiResponse = ApiResponse<InvalidateSchemaCacheResponse>

// ============================================================================
// Zod Schemas for Params
// ============================================================================

const branchParamsSchema = z.object({
  branch: branchNameSchema,
})

const collectionParamsSchema = z.object({
  branch: branchNameSchema,
  collectionPath: logicalPathSchema,
})

const entryTypeParamsSchema = z.object({
  branch: branchNameSchema,
  collectionPath: logicalPathSchema,
  entryTypeName: z.string().min(1),
})

// Body schemas for mutations
const createCollectionBodySchema = createCollectionInputSchema

const updateCollectionBodySchema = updateCollectionInputSchema

const addEntryTypeBodySchema = entryTypeInputSchema

const updateEntryTypeBodySchema = updateEntryTypeInputSchema

const updateOrderBodySchema = z.object({
  order: z.array(z.string()),
})

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get a SchemaOps instance for a branch
 */
async function getSchemaOps(
  ctx: ApiContext,
  branchName: string,
): Promise<{ store: SchemaOps; branchRoot: string } | { error: string; status: number }> {
  const context = await ctx.getBranchContext(branchName)
  if (!context) {
    return { error: 'Branch not found', status: 404 }
  }

  const contentRoot = path.join(context.branchRoot, 'content')
  const store = new SchemaOps(contentRoot, ctx.services.entrySchemaRegistry, ctx.services)
  return { store, branchRoot: context.branchRoot }
}

/**
 * Check admin authorization
 */
function checkAdminAuth(req: ApiRequest): { error: string; status: number } | null {
  if (!isAdmin(req.user.groups)) {
    return { error: 'Admin access required', status: 403 }
  }
  return null
}

/**
 * Decode a collection path from URL params.
 * The path is validated by Zod before decoding, then re-validated after
 * decoding to prevent double-encoding path traversal attacks.
 */
function decodeCollectionPath(
  collectionPath: LogicalPath,
): { ok: true; path: LogicalPath } | { ok: false; error: string } {
  const decoded = decodeURIComponent(collectionPath)
  if (decoded === collectionPath) {
    return { ok: true, path: collectionPath }
  }
  const result = parseLogicalPath(decoded)
  if (!result.ok) {
    return { ok: false, error: `Invalid collection path after decoding: ${result.error}` }
  }
  return { ok: true, path: result.path }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /:branch/schema - Get full schema tree
 */
const getSchemaHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamsSchema>,
): Promise<GetSchemaApiResponse> => {
  // Check branch access before loading any data
  const accessResult = await guardBranchAccess(ctx, req, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult

  const context = await ctx.getBranchContext(params.branch, {
    loadSchema: true,
  })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  if (!context.flatSchema) {
    return { ok: false, status: 500, error: 'Schema not loaded for branch' }
  }

  return {
    ok: true,
    status: 200,
    data: {
      flatSchema: toWireFlatSchema(context.flatSchema, ctx.services.entrySchemaRegistry),
      entrySchemas: ctx.services.entrySchemaRegistry,
    },
  }
}

/**
 * GET /:branch/schema/collection/...collectionPath - Get single collection details
 * Note: Uses 'collection' (singular) with catch-all to support paths with slashes
 */
const getCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
): Promise<GetCollectionApiResponse> => {
  // Check branch access before loading any data
  const accessResult = await guardBranchAccess(ctx, req, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult

  const context = await ctx.getBranchContext(params.branch, {
    loadSchema: true,
  })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const decodedPath = decodeCollectionPath(params.collectionPath)
  if (!decodedPath.ok) {
    return { ok: false, status: 400, error: decodedPath.error }
  }
  const collectionPath = decodedPath.path

  // Find collection in per-branch flat schema
  if (!context.flatSchema) {
    return { ok: false, status: 500, error: 'Schema not loaded for branch' }
  }
  const flatSchema = context.flatSchema
  const item = flatSchema.find((i) => i.type === 'collection' && i.logicalPath === collectionPath)

  if (!item || item.type !== 'collection') {
    return {
      ok: true,
      status: 200,
      data: { collection: null },
    }
  }

  // Build wire-format collection from FlatSchemaItem
  const registry = ctx.services.entrySchemaRegistry
  const collection: WireCollectionConfig = {
    name: item.name,
    path: item.logicalPath,
    ...(item.label !== undefined && { label: item.label }),
    ...(item.entries && {
      entries: item.entries.map((et) => toWireEntryType(et, registry)),
    }),
    ...(item.collections && {
      collections: item.collections.map((c) => toWireCollection(c, registry)),
    }),
    ...(item.order && { order: item.order }),
  }

  // Compute usage counts for each entry type
  // Read from raw collection meta to get entry schema registry keys (strings), not resolved EntrySchema
  let entryTypesWithUsage: EntryTypeWithUsage[] | undefined
  if (item.entries && item.entries.length > 0) {
    const storeResult = await getSchemaOps(ctx, params.branch)
    if ('error' in storeResult) {
      return { ok: false, status: storeResult.status, error: storeResult.error }
    }

    // Read raw collection meta to get string schema references
    const rawMeta = await storeResult.store.readCollectionMeta(collectionPath)
    if (rawMeta?.entries) {
      entryTypesWithUsage = await Promise.all(
        rawMeta.entries.map(async (et) => {
          const usageCount = await storeResult.store.countEntriesUsingType(collectionPath, et.name)
          return {
            name: et.name,
            label: et.label,
            format: et.format,
            schemaRef: et.schema, // String reference to entry schema registry
            default: et.default,
            maxItems: et.maxItems,
            usageCount,
          }
        }),
      )
    }
  }

  return {
    ok: true,
    status: 200,
    data: { collection, entryTypesWithUsage },
  }
}

/**
 * POST /:branch/schema/collections - Create collection
 */
const createCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamsSchema>,
  body: z.infer<typeof createCollectionBodySchema>,
): Promise<CreateCollectionApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const storeResult = await getSchemaOps(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  try {
    const result = await storeResult.store.createCollection(body as CreateCollectionInput)
    return {
      ok: true,
      status: 201,
      data: result,
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(err),
    }
  }
}

/**
 * PATCH /:branch/schema/collection/...collectionPath - Update collection
 * Note: Uses 'collection' (singular) with catch-all to support paths with slashes
 */
const updateCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
  body: z.infer<typeof updateCollectionBodySchema>,
): Promise<UpdateCollectionApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const storeResult = await getSchemaOps(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const decodedPath = decodeCollectionPath(params.collectionPath)
  if (!decodedPath.ok) {
    return { ok: false, status: 400, error: decodedPath.error }
  }
  const collectionPath = decodedPath.path

  try {
    await storeResult.store.updateCollection(collectionPath, body as UpdateCollectionInput)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(err),
    }
  }
}

/**
 * DELETE /:branch/schema/collection/...collectionPath - Delete collection
 * Note: Uses 'collection' (singular) with catch-all to support paths with slashes
 */
const deleteCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
): Promise<DeleteCollectionApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const storeResult = await getSchemaOps(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const decodedPath = decodeCollectionPath(params.collectionPath)
  if (!decodedPath.ok) {
    return { ok: false, status: 400, error: decodedPath.error }
  }
  const collectionPath = decodedPath.path

  try {
    await storeResult.store.deleteCollection(collectionPath)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(err),
    }
  }
}

/**
 * POST /:branch/schema/entry-types/...collectionPath - Add entry type
 * Note: Restructured URL with catch-all at end to support paths with slashes
 */
const addEntryTypeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
  body: z.infer<typeof addEntryTypeBodySchema>,
): Promise<AddEntryTypeApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const storeResult = await getSchemaOps(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const decodedPath = decodeCollectionPath(params.collectionPath)
  if (!decodedPath.ok) {
    return { ok: false, status: 400, error: decodedPath.error }
  }
  const collectionPath = decodedPath.path

  try {
    await storeResult.store.addEntryType(collectionPath, body as CreateEntryTypeInput)
    return {
      ok: true,
      status: 201,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(err),
    }
  }
}

/**
 * PATCH /:branch/schema/entry-types/:entryTypeName/...collectionPath - Update entry type
 * Note: Restructured URL with entry type name before catch-all path
 */
const updateEntryTypeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof entryTypeParamsSchema>,
  body: z.infer<typeof updateEntryTypeBodySchema>,
): Promise<UpdateEntryTypeApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const storeResult = await getSchemaOps(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const decodedPath = decodeCollectionPath(params.collectionPath)
  if (!decodedPath.ok) {
    return { ok: false, status: 400, error: decodedPath.error }
  }
  const collectionPath = decodedPath.path

  // Check if format or schema are being changed (breaking changes)
  const isBreakingChange = body.format !== undefined || body.schema !== undefined
  if (isBreakingChange) {
    // Count existing entries using this type
    const usageCount = await storeResult.store.countEntriesUsingType(
      collectionPath,
      params.entryTypeName,
    )
    if (usageCount > 0) {
      const entryWord = usageCount === 1 ? 'entry' : 'entries'
      return {
        ok: false,
        status: 400,
        error: `Cannot modify schema or format for entry type with existing ${entryWord}. ${usageCount} ${entryWord} currently use this type.`,
      }
    }
  }

  try {
    await storeResult.store.updateEntryType(
      collectionPath,
      params.entryTypeName,
      body as UpdateEntryTypeInput,
    )
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(err),
    }
  }
}

/**
 * DELETE /:branch/schema/entry-types/:entryTypeName/...collectionPath - Remove entry type
 * Note: Restructured URL with entry type name before catch-all path
 */
const removeEntryTypeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof entryTypeParamsSchema>,
): Promise<RemoveEntryTypeApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const storeResult = await getSchemaOps(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const decodedPath = decodeCollectionPath(params.collectionPath)
  if (!decodedPath.ok) {
    return { ok: false, status: 400, error: decodedPath.error }
  }
  const collectionPath = decodedPath.path

  try {
    await storeResult.store.removeEntryType(collectionPath, params.entryTypeName)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(err),
    }
  }
}

/**
 * PATCH /:branch/schema/order/...collectionPath - Update item order
 * Note: Restructured URL with catch-all at end to support paths with slashes
 */
const updateOrderHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
  body: z.infer<typeof updateOrderBodySchema>,
): Promise<UpdateOrderApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const storeResult = await getSchemaOps(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const decodedPath = decodeCollectionPath(params.collectionPath)
  if (!decodedPath.ok) {
    return { ok: false, status: 400, error: decodedPath.error }
  }
  const collectionPath = decodedPath.path

  try {
    await storeResult.store.updateOrder(collectionPath, body.order)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: getErrorMessage(err),
    }
  }
}

/**
 * POST /:branch/schema/invalidate-cache - Invalidate schema cache (for debugging/manual refresh)
 */
const invalidateSchemaCacheHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamsSchema>,
): Promise<InvalidateSchemaCacheApiResponse> => {
  // Check admin auth
  const authError = checkAdminAuth(req)
  if (authError) {
    return { ok: false, status: authError.status, error: authError.error }
  }

  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  try {
    await ctx.services.branchSchemaCache.invalidate(context.branchRoot)
    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        message: 'Schema cache invalidated. Next schema load will regenerate cache.',
      },
    }
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: getErrorMessage(err),
    }
  }
}

// ============================================================================
// Route Definitions
// ============================================================================

/**
 * GET /:branch/schema - Get full schema
 */
export const getSchema = defineEndpoint({
  namespace: 'schema',
  name: 'get',
  method: 'GET',
  path: '/:branch/schema',
  params: branchParamsSchema,
  responseType: 'GetSchemaApiResponse',
  response: {} as GetSchemaApiResponse,
  defaultMockData: { flatSchema: [], entrySchemas: {} },
  handler: getSchemaHandler,
})

/**
 * GET /:branch/schema/collection/...collectionPath - Get single collection
 * Note: Uses 'collection' (singular) with catch-all to support paths with slashes
 */
export const getCollection = defineEndpoint({
  namespace: 'schema',
  name: 'getCollection',
  method: 'GET',
  path: '/:branch/schema/collection/...collectionPath',
  params: collectionParamsSchema,
  responseType: 'GetCollectionApiResponse',
  response: {} as GetCollectionApiResponse,
  defaultMockData: { collection: null },
  handler: getCollectionHandler,
})

/**
 * POST /:branch/schema/collections - Create collection
 */
export const createCollection = defineEndpoint({
  namespace: 'schema',
  name: 'createCollection',
  method: 'POST',
  path: '/:branch/schema/collections',
  params: branchParamsSchema,
  body: createCollectionBodySchema,
  bodyType: 'CreateCollectionInput',
  responseType: 'CreateCollectionApiResponse',
  response: {} as CreateCollectionApiResponse,
  defaultMockData: { collectionPath: '', contentId: '' },
  mockDataCasts: {
    collectionPath: 'createLogicalPath',
    contentId: 'as ContentId',
  },
  handler: createCollectionHandler,
})

/**
 * PATCH /:branch/schema/collection/...collectionPath - Update collection
 * Note: Uses 'collection' (singular) with catch-all to support paths with slashes
 */
export const updateCollection = defineEndpoint({
  namespace: 'schema',
  name: 'updateCollection',
  method: 'PATCH',
  path: '/:branch/schema/collection/...collectionPath',
  params: collectionParamsSchema,
  body: updateCollectionBodySchema,
  bodyType: 'UpdateCollectionInput',
  responseType: 'UpdateCollectionApiResponse',
  response: {} as UpdateCollectionApiResponse,
  defaultMockData: { success: true },
  handler: updateCollectionHandler,
})

/**
 * DELETE /:branch/schema/collection/...collectionPath - Delete collection
 * Note: Uses 'collection' (singular) with catch-all to support paths with slashes
 */
export const deleteCollection = defineEndpoint({
  namespace: 'schema',
  name: 'deleteCollection',
  method: 'DELETE',
  path: '/:branch/schema/collection/...collectionPath',
  params: collectionParamsSchema,
  responseType: 'DeleteCollectionApiResponse',
  response: {} as DeleteCollectionApiResponse,
  defaultMockData: { success: true },
  handler: deleteCollectionHandler,
})

/**
 * POST /:branch/schema/entry-types/...collectionPath - Add entry type
 * Note: Restructured URL with catch-all at end to support paths with slashes
 */
export const addEntryType = defineEndpoint({
  namespace: 'schema',
  name: 'addEntryType',
  method: 'POST',
  path: '/:branch/schema/entry-types/...collectionPath',
  params: collectionParamsSchema,
  body: addEntryTypeBodySchema,
  bodyType: 'CreateEntryTypeInput',
  responseType: 'AddEntryTypeApiResponse',
  response: {} as AddEntryTypeApiResponse,
  defaultMockData: { success: true },
  handler: addEntryTypeHandler,
})

/**
 * PATCH /:branch/schema/entry-types/:entryTypeName/...collectionPath - Update entry type
 * Note: Restructured URL with entry type name before catch-all path
 */
export const updateEntryType = defineEndpoint({
  namespace: 'schema',
  name: 'updateEntryType',
  method: 'PATCH',
  path: '/:branch/schema/entry-types/:entryTypeName/...collectionPath',
  params: entryTypeParamsSchema,
  body: updateEntryTypeBodySchema,
  bodyType: 'UpdateEntryTypeInput',
  responseType: 'UpdateEntryTypeApiResponse',
  response: {} as UpdateEntryTypeApiResponse,
  defaultMockData: { success: true },
  handler: updateEntryTypeHandler,
})

/**
 * DELETE /:branch/schema/entry-types/:entryTypeName/...collectionPath - Remove entry type
 * Note: Restructured URL with entry type name before catch-all path
 */
export const removeEntryType = defineEndpoint({
  namespace: 'schema',
  name: 'removeEntryType',
  method: 'DELETE',
  path: '/:branch/schema/entry-types/:entryTypeName/...collectionPath',
  params: entryTypeParamsSchema,
  responseType: 'RemoveEntryTypeApiResponse',
  response: {} as RemoveEntryTypeApiResponse,
  defaultMockData: { success: true },
  handler: removeEntryTypeHandler,
})

/**
 * PATCH /:branch/schema/order/...collectionPath - Update item order
 * Note: Restructured URL with catch-all at end to support paths with slashes
 */
export const updateOrder = defineEndpoint({
  namespace: 'schema',
  name: 'updateOrder',
  method: 'PATCH',
  path: '/:branch/schema/order/...collectionPath',
  params: collectionParamsSchema,
  body: updateOrderBodySchema,
  bodyType: 'UpdateOrderBody',
  responseType: 'UpdateOrderApiResponse',
  response: {} as UpdateOrderApiResponse,
  defaultMockData: { success: true },
  handler: updateOrderHandler,
})

/**
 * POST /:branch/schema/invalidate-cache - Invalidate schema cache
 */
export const invalidateSchemaCache = defineEndpoint({
  namespace: 'schema',
  name: 'invalidateSchemaCache',
  method: 'POST',
  path: '/:branch/schema/invalidate-cache',
  params: branchParamsSchema,
  responseType: 'InvalidateSchemaCacheApiResponse',
  response: {} as InvalidateSchemaCacheApiResponse,
  defaultMockData: { success: true, message: 'Cache invalidated' },
  handler: invalidateSchemaCacheHandler,
})

// ============================================================================
// Exports
// ============================================================================

/** Body type for updateOrder endpoint */
export type UpdateOrderBody = z.infer<typeof updateOrderBodySchema>

export const SCHEMA_ROUTES = {
  get: getSchema,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addEntryType,
  updateEntryType,
  removeEntryType,
  updateOrder,
  invalidateSchemaCache,
} as const
