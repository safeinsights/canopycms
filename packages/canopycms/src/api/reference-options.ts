import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { ContentStore } from '../content-store'
import { resolveBranchPaths } from '../paths'
import { defineEndpoint } from './route-builder'
import { ReferenceResolver } from '../reference-resolver'

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
  branch: z.string().min(1),
})

const getReferenceOptionsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof getReferenceOptionsParamsSchema>,
): Promise<ReferenceOptionsResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Manual query parameter validation
  const collectionsParam = req.query?.collections as string | undefined
  if (!collectionsParam) {
    return { ok: false, status: 400, error: 'Query parameter "collections" is required' }
  }

  const displayField = (req.query?.displayField as string) || 'title'
  const search = req.query?.search as string | undefined

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const store = new ContentStore(branchPaths.branchRoot, ctx.services.flatSchema)

  // Get ID index (automatically loads if needed)
  const idIndex = await store.idIndex()

  // Parse collections
  const collections = collectionsParam
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)

  // Load reference options
  const contentRoot = ctx.services.config.contentRoot ?? 'content'
  const resolver = new ReferenceResolver(store, idIndex, contentRoot)
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
