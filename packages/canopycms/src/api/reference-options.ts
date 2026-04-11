import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContextWithSchema } from '../types'
import { ContentStore } from '../content-store'
import { defineEndpoint } from './route-builder'
import { ReferenceResolver } from '../reference-resolver'
import { parseLogicalPath } from '../paths'
import type { ContentId, LogicalPath } from '../paths/types'
import { branchNameSchema } from './validators'

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
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof getReferenceOptionsParamsSchema>,
): Promise<ReferenceOptionsResponse> => {
  const { branchContext } = gc

  // Query parameter validation — at least one of collections or entryTypes is required
  const querySchema = z
    .object({
      collections: z.string().optional(),
      entryTypes: z.string().optional(),
      displayField: z.string().optional(),
      search: z.string().optional(),
    })
    .refine((data) => data.collections || data.entryTypes, {
      message: 'At least one of "collections" or "entryTypes" query parameters is required',
    })
  const queryResult = querySchema.safeParse(req.query ?? {})
  if (!queryResult.success) {
    return {
      ok: false,
      status: 400,
      error: queryResult.error.issues[0]?.message ?? 'Invalid query parameters',
    }
  }

  const collectionsParam = queryResult.data.collections
  const entryTypesParam = queryResult.data.entryTypes
  const displayField = queryResult.data.displayField || 'title'
  const search = queryResult.data.search

  const flatSchema = branchContext.flatSchema
  const store = new ContentStore(branchContext.branchRoot, flatSchema)

  // Get ID index (automatically loads if needed)
  const idIndex = await store.idIndex()

  // Parse and validate collections from query params
  let collections: LogicalPath[] | undefined
  if (collectionsParam) {
    const rawCollections = collectionsParam
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    collections = []
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
  }

  // Parse entry types from query params
  const entryTypes = entryTypesParam
    ? entryTypesParam
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined

  // Load reference options
  const resolver = new ReferenceResolver(store, idIndex)
  const allOptions = await resolver.loadReferenceOptions(
    collections,
    displayField,
    search,
    entryTypes,
  )

  // Filter by path-level read permissions
  const options = []
  for (const option of allOptions) {
    const location = idIndex.findById(option.id as ContentId)
    if (!location) continue
    const access = await ctx.services.checkContentAccess(
      branchContext,
      branchContext.branchRoot,
      location.relativePath,
      req.user,
      'read',
    )
    if (!access.allowed) continue
    options.push(option)
  }

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
 * Query params: collections (comma-separated, optional), entryTypes (comma-separated, optional),
 *   displayField, search. At least one of collections or entryTypes is required.
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
  guards: ['branchAccessWithSchema'] as const,
  handler: getReferenceOptionsHandler,
})

/**
 * Exported routes for router registration
 */
export const REFERENCE_OPTIONS_ROUTES = {
  get: getReferenceOptions,
} as const
