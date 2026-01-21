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

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import { isAdmin } from '../authorization/helpers'
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
import type { RootCollectionConfig, CollectionConfig, FlatSchemaItem } from '../config'
import { parseLogicalPath, type LogicalPath } from '../paths'

// ============================================================================
// Response Types
// ============================================================================

export interface SchemaResponse {
  schema: RootCollectionConfig
  flatSchema: FlatSchemaItem[]
}

export interface CollectionResponse {
  collection: CollectionConfig | null
}

export interface CreateCollectionResponse {
  /** The logical path to the created collection (e.g., "posts" or "blog/posts") */
  collectionPath: LogicalPath
  /** The unique 12-character content ID for the collection */
  contentId: string
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

export type GetSchemaApiResponse = ApiResponse<SchemaResponse>
export type GetCollectionApiResponse = ApiResponse<CollectionResponse>
export type CreateCollectionApiResponse = ApiResponse<CreateCollectionResponse>
export type UpdateCollectionApiResponse = ApiResponse<UpdateCollectionResponse>
export type DeleteCollectionApiResponse = ApiResponse<DeleteCollectionResponse>
export type AddEntryTypeApiResponse = ApiResponse<AddEntryTypeResponse>
export type UpdateEntryTypeApiResponse = ApiResponse<UpdateEntryTypeResponse>
export type RemoveEntryTypeApiResponse = ApiResponse<RemoveEntryTypeResponse>
export type UpdateOrderApiResponse = ApiResponse<UpdateOrderResponse>

// ============================================================================
// Zod Schemas for Params
// ============================================================================

const branchParamsSchema = z.object({
  branch: z.string().min(1),
})

const collectionParamsSchema = z.object({
  branch: z.string().min(1),
  collectionPath: z.string().min(1),
})

const entryTypeParamsSchema = z.object({
  branch: z.string().min(1),
  collectionPath: z.string().min(1),
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
  branchName: string
): Promise<{ store: SchemaStore; branchRoot: string } | { error: string; status: number }> {
  const context = await ctx.getBranchContext(branchName)
  if (!context) {
    return { error: 'Branch not found', status: 404 }
  }

  const store = new SchemaStore(context.branchRoot, ctx.services.schemaRegistry)
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
 * Validate and parse a collection path from URL params.
 * Returns a typed LogicalPath or an error response.
 */
function validateCollectionPath(
  rawPath: string
): { ok: true; path: LogicalPath } | { ok: false; status: number; error: string } {
  const result = parseLogicalPath(decodeURIComponent(rawPath))
  if (!result.ok) {
    return { ok: false, status: 400, error: result.error }
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
  params: z.infer<typeof branchParamsSchema>
): Promise<GetSchemaApiResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  return {
    ok: true,
    status: 200,
    data: {
      schema: ctx.services.config.schema || {},
      flatSchema: ctx.services.flatSchema,
    },
  }
}

/**
 * GET /:branch/schema/collections/:collectionPath - Get single collection details
 */
const getCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>
): Promise<GetCollectionApiResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Validate collection path
  const pathResult = validateCollectionPath(params.collectionPath)
  if (!pathResult.ok) {
    return { ok: false, status: pathResult.status, error: pathResult.error }
  }

  // Find collection in flat schema
  const item = ctx.services.flatSchema.find(
    (i) => i.type === 'collection' && i.logicalPath === pathResult.path
  )

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

  return {
    ok: true,
    status: 200,
    data: { collection },
  }
}

/**
 * POST /:branch/schema/collections - Create collection
 */
const createCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamsSchema>,
  body: z.infer<typeof createCollectionBodySchema>
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
      error: err instanceof Error ? err.message : 'Failed to create collection',
    }
  }
}

/**
 * PATCH /:branch/schema/collections/:collectionPath - Update collection
 */
const updateCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
  body: z.infer<typeof updateCollectionBodySchema>
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

  // Validate collection path
  const pathResult = validateCollectionPath(params.collectionPath)
  if (!pathResult.ok) {
    return { ok: false, status: pathResult.status, error: pathResult.error }
  }

  try {
    await storeResult.store.updateCollection(pathResult.path, body as UpdateCollectionInput)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'Failed to update collection',
    }
  }
}

/**
 * DELETE /:branch/schema/collections/:collectionPath - Delete collection
 */
const deleteCollectionHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>
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

  // Validate collection path
  const pathResult = validateCollectionPath(params.collectionPath)
  if (!pathResult.ok) {
    return { ok: false, status: pathResult.status, error: pathResult.error }
  }

  try {
    await storeResult.store.deleteCollection(pathResult.path)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'Failed to delete collection',
    }
  }
}

/**
 * POST /:branch/schema/collections/:collectionPath/entry-types - Add entry type
 */
const addEntryTypeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
  body: z.infer<typeof addEntryTypeBodySchema>
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

  // Validate collection path
  const pathResult = validateCollectionPath(params.collectionPath)
  if (!pathResult.ok) {
    return { ok: false, status: pathResult.status, error: pathResult.error }
  }

  try {
    await storeResult.store.addEntryType(pathResult.path, body as CreateEntryTypeInput)
    return {
      ok: true,
      status: 201,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'Failed to add entry type',
    }
  }
}

/**
 * PATCH /:branch/schema/collections/:collectionPath/entry-types/:entryTypeName - Update entry type
 */
const updateEntryTypeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof entryTypeParamsSchema>,
  body: z.infer<typeof updateEntryTypeBodySchema>
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

  // Validate collection path
  const pathResult = validateCollectionPath(params.collectionPath)
  if (!pathResult.ok) {
    return { ok: false, status: pathResult.status, error: pathResult.error }
  }

  try {
    await storeResult.store.updateEntryType(
      pathResult.path,
      params.entryTypeName,
      body as UpdateEntryTypeInput
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
      error: err instanceof Error ? err.message : 'Failed to update entry type',
    }
  }
}

/**
 * DELETE /:branch/schema/collections/:collectionPath/entry-types/:entryTypeName - Remove entry type
 */
const removeEntryTypeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof entryTypeParamsSchema>
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

  // Validate collection path
  const pathResult = validateCollectionPath(params.collectionPath)
  if (!pathResult.ok) {
    return { ok: false, status: pathResult.status, error: pathResult.error }
  }

  try {
    await storeResult.store.removeEntryType(pathResult.path, params.entryTypeName)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'Failed to remove entry type',
    }
  }
}

/**
 * PATCH /:branch/schema/collections/:collectionPath/order - Update item order
 */
const updateOrderHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof collectionParamsSchema>,
  body: z.infer<typeof updateOrderBodySchema>
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

  // Validate collection path
  const pathResult = validateCollectionPath(params.collectionPath)
  if (!pathResult.ok) {
    return { ok: false, status: pathResult.status, error: pathResult.error }
  }

  try {
    await storeResult.store.updateOrder(pathResult.path, body.order)
    return {
      ok: true,
      status: 200,
      data: { success: true },
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'Failed to update order',
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
  defaultMockData: { schema: {}, flatSchema: [] },
  handler: getSchemaHandler,
})

/**
 * GET /:branch/schema/collections/:collectionPath - Get single collection
 */
export const getCollection = defineEndpoint({
  namespace: 'schema',
  name: 'getCollection',
  method: 'GET',
  path: '/:branch/schema/collections/:collectionPath',
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
 * PATCH /:branch/schema/collections/:collectionPath - Update collection
 */
export const updateCollection = defineEndpoint({
  namespace: 'schema',
  name: 'updateCollection',
  method: 'PATCH',
  path: '/:branch/schema/collections/:collectionPath',
  params: collectionParamsSchema,
  body: updateCollectionBodySchema,
  bodyType: 'UpdateCollectionInput',
  responseType: 'UpdateCollectionApiResponse',
  response: {} as UpdateCollectionApiResponse,
  defaultMockData: { success: true },
  handler: updateCollectionHandler,
})

/**
 * DELETE /:branch/schema/collections/:collectionPath - Delete collection
 */
export const deleteCollection = defineEndpoint({
  namespace: 'schema',
  name: 'deleteCollection',
  method: 'DELETE',
  path: '/:branch/schema/collections/:collectionPath',
  params: collectionParamsSchema,
  responseType: 'DeleteCollectionApiResponse',
  response: {} as DeleteCollectionApiResponse,
  defaultMockData: { success: true },
  handler: deleteCollectionHandler,
})

/**
 * POST /:branch/schema/collections/:collectionPath/entry-types - Add entry type
 */
export const addEntryType = defineEndpoint({
  namespace: 'schema',
  name: 'addEntryType',
  method: 'POST',
  path: '/:branch/schema/collections/:collectionPath/entry-types',
  params: collectionParamsSchema,
  body: addEntryTypeBodySchema,
  bodyType: 'CreateEntryTypeInput',
  responseType: 'AddEntryTypeApiResponse',
  response: {} as AddEntryTypeApiResponse,
  defaultMockData: { success: true },
  handler: addEntryTypeHandler,
})

/**
 * PATCH /:branch/schema/collections/:collectionPath/entry-types/:entryTypeName - Update entry type
 */
export const updateEntryType = defineEndpoint({
  namespace: 'schema',
  name: 'updateEntryType',
  method: 'PATCH',
  path: '/:branch/schema/collections/:collectionPath/entry-types/:entryTypeName',
  params: entryTypeParamsSchema,
  body: updateEntryTypeBodySchema,
  bodyType: 'UpdateEntryTypeInput',
  responseType: 'UpdateEntryTypeApiResponse',
  response: {} as UpdateEntryTypeApiResponse,
  defaultMockData: { success: true },
  handler: updateEntryTypeHandler,
})

/**
 * DELETE /:branch/schema/collections/:collectionPath/entry-types/:entryTypeName - Remove entry type
 */
export const removeEntryType = defineEndpoint({
  namespace: 'schema',
  name: 'removeEntryType',
  method: 'DELETE',
  path: '/:branch/schema/collections/:collectionPath/entry-types/:entryTypeName',
  params: entryTypeParamsSchema,
  responseType: 'RemoveEntryTypeApiResponse',
  response: {} as RemoveEntryTypeApiResponse,
  defaultMockData: { success: true },
  handler: removeEntryTypeHandler,
})

/**
 * PATCH /:branch/schema/collections/:collectionPath/order - Update item order
 */
export const updateOrder = defineEndpoint({
  namespace: 'schema',
  name: 'updateOrder',
  method: 'PATCH',
  path: '/:branch/schema/collections/:collectionPath/order',
  params: collectionParamsSchema,
  body: updateOrderBodySchema,
  bodyType: 'UpdateOrderBody',
  responseType: 'UpdateOrderApiResponse',
  response: {} as UpdateOrderApiResponse,
  defaultMockData: { success: true },
  handler: updateOrderHandler,
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
} as const
