import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { ContentStore } from '../content-store'
import { defineEndpoint } from './route-builder'
import { ReferenceResolver } from '../reference-resolver'
import { parseLogicalPath } from '../paths'
import type { LogicalPath } from '../paths/types'
import { branchNameSchema } from './validators'
import { guardBranchAccess, isBranchAccessError } from './middleware'

/** Response type for reference options */
export type ReferenceOptionsResponse = ApiResponse<{
  options: Array<{
    id: string
    label: string
    collection: string
  }>
}>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const getReferenceOptionsParamsSchema = z.object({
  branch: branchNameSchema,
})

const getReferenceOptionsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof getReferenceOptionsParamsSchema>,
): Promise<ReferenceOptionsResponse> => {
  // Check branch access before loading any data
  const accessResult = await guardBranchAccess(ctx, req, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult

  const context = await ctx.getBranchContext(params.branch, {
    loadSchema: true,
  })
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Query parameter validation
  const querySchema = z.object({
    collections: z.string().min(1),
    displayField: z.string().optional(),
    search: z.string().optional(),
  })
  const queryResult = querySchema.safeParse(req.query ?? {})
  if (!queryResult.success) {
    return {
      ok: false,
      status: 400,
      error: 'Query parameter "collections" is required',
    }
  }

  const collectionsParam = queryResult.data.collections
  const displayField = queryResult.data.displayField || 'title'
  const search = queryResult.data.search

  if (!context.flatSchema) {
    return { ok: false, status: 500, error: 'Schema not loaded for branch' }
  }
  const flatSchema = context.flatSchema
  const store = new ContentStore(context.branchRoot, flatSchema)

  // Get ID index (automatically loads if needed)
  const idIndex = await store.idIndex()

  // Parse and validate collections from query params
  const rawCollections = collectionsParam
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  const collections: LogicalPath[] = []
  for (const raw of rawCollections) {
    const result = parseLogicalPath(raw)
    if (!result.ok) {
      return {
        ok: false,
        status: 400,
        error: `Invalid collection path "${raw}": ${result.error}`,
      }
    }
    collections.push(result.path)
  }

  // Load reference options
  const resolver = new ReferenceResolver(store, idIndex)
  const options = await resolver.loadReferenceOptions(collections, displayField, search)

  return {
    ok: true,
    status: 200,
    data: { options },
  }
}

// ============================================================================
// Route Definitions
// ============================================================================

/**
 * Get reference options for a field
 * GET /:branch/reference-options
 * Query params: collections (comma-separated), displayField, search
 */
const getReferenceOptions = defineEndpoint({
  namespace: 'content',
  name: 'getReferenceOptions',
  method: 'GET',
  path: '/:branch/reference-options',
  params: getReferenceOptionsParamsSchema,
  responseType: 'ReferenceOptionsResponse',
  response: {} as ReferenceOptionsResponse,
  defaultMockData: { options: [] },
  handler: getReferenceOptionsHandler,
})

/**
 * Exported routes for router registration
 */
export const REFERENCE_OPTIONS_ROUTES = {
  get: getReferenceOptions,
} as const
