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
import {
  SchemaStore,
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
  RootCollectionConfig,
  CollectionConfig,
  FlatSchemaItem,
  ContentFormat,
} from '../config'
import { type LogicalPath, type ContentId } from '../paths'

// ============================================================================
// Response Types
// ============================================================================

export interface SchemaResponse {
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
  /** Available schema registry keys that can be used for entry type `fields` */
  availableSchemas: string[]
}

export interface EntryTypeWithUsage {
  name: string
  label?: string
  format: ContentFormat
  fields: string
  default?: boolean
  maxItems?: number
  /** Number of entries using this entry type (for locking validation) */
  usageCount: number
}

export interface CollectionResponse {
  collection: CollectionConfig | null
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
 * Get a SchemaStore instance for a branch
 */
async function getSchemaStore(
  ctx: ApiContext,
  branchName: string,
): Promise<{ store: SchemaStore; branchRoot: string } | { error: string; status: number }> {
  const context = await ctx.getBranchContext(branchName)
  if (!context) {
    return { error: 'Branch not found', status: 404 }
  }

  const contentRoot = path.join(context.branchRoot, 'content')
  const store = new SchemaStore(contentRoot, ctx.services.schemaRegistry, ctx.services)
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
 * The path is already validated and branded as LogicalPath by the Zod schema;
 * this only applies URI decoding for catch-all route segments.
 */
function decodeCollectionPath(collectionPath: LogicalPath): LogicalPath {
  return decodeURIComponent(collectionPath) as LogicalPath
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
  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  return {
    ok: true,
    status: 200,
    data: {
      schema: context.schema!,
      flatSchema: context.flatSchema!,
      availableSchemas: Object.keys(ctx.services.schemaRegistry),
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
  const context = await ctx.getBranchContext(params.branch, { loadSchema: true })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const collectionPath = decodeCollectionPath(params.collectionPath)

  // Find collection in per-branch flat schema
  const flatSchema = context.flatSchema!
  const item = flatSchema.find((i) => i.type === 'collection' && i.logicalPath === collectionPath)

  if (!item || item.type !== 'collection') {
    return {
      ok: true,
      status: 200,
      data: { collection: null },
    }
  }

  // Build CollectionConfig from FlatSchemaItem
  const collection: CollectionConfig = {
    name: item.name,
    path: item.logicalPath,
    label: item.label,
    entries: item.entries,
    collections: item.collections,
    order: item.order,
  }

  // Compute usage counts for each entry type
  // Read from raw collection meta to get schema registry keys (strings), not resolved FieldConfig[]
  let entryTypesWithUsage: EntryTypeWithUsage[] | undefined
  if (item.entries && item.entries.length > 0) {
    const storeResult = await getSchemaStore(ctx, params.branch)
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
            fields: et.fields, // String reference to schema registry
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

  const storeResult = await getSchemaStore(ctx, params.branch)
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

  const storeResult = await getSchemaStore(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const collectionPath = decodeCollectionPath(params.collectionPath)

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

  const storeResult = await getSchemaStore(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const collectionPath = decodeCollectionPath(params.collectionPath)

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

  const storeResult = await getSchemaStore(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const collectionPath = decodeCollectionPath(params.collectionPath)

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

  const storeResult = await getSchemaStore(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const collectionPath = decodeCollectionPath(params.collectionPath)

  // Check if format or fields are being changed (breaking changes)
  const isBreakingChange = body.format !== undefined || body.fields !== undefined
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

  const storeResult = await getSchemaStore(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const collectionPath = decodeCollectionPath(params.collectionPath)

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

  const storeResult = await getSchemaStore(ctx, params.branch)
  if ('error' in storeResult) {
    return { ok: false, status: storeResult.status, error: storeResult.error }
  }

  const collectionPath = decodeCollectionPath(params.collectionPath)

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
    await ctx.services.schemaCacheRegistry.invalidate(context.branchRoot)
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
  defaultMockData: { schema: {}, flatSchema: [], availableSchemas: [] },
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
  mockDataCasts: { collectionPath: 'toLogicalPath' },
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
