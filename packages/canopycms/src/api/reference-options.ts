import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContextWithSchema } from '../types'
import { ContentStore } from '../content-store'
import { defineEndpoint } from './route-builder'
import { ReferenceResolver, type ReferenceOption } from '../reference-resolver'
import type { ReferenceOptionSort } from '../config'
import { referenceSortFieldSchema } from '../config/schemas/field'
import { parseLogicalPath } from '../paths'
import type { LogicalPath } from '../paths/types'
import { branchNameSchema } from './validators'

export type ReferenceOptionsResponse = ApiResponse<{
  options: ReferenceOption[]
}>

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
      sort: z.enum(['label', 'collection', 'field']).optional(),
      sortField: referenceSortFieldSchema.optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
    })
    .refine((data) => data.collections || data.entryTypes, {
      message: 'At least one of "collections" or "entryTypes" query parameters is required',
    })
    .refine((data) => (data.sort === 'field') === (data.sortField !== undefined), {
      message: '"sortField" is required with sort=field, and only allowed with it',
    })
    .refine((data) => data.sortDir === undefined || data.sort === 'field', {
      message: '"sortDir" is only allowed with sort=field',
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
  // The refinements above pair sortField with sort=field, so sortField alone decides.
  const { sort: sortParam, sortField, sortDir } = queryResult.data
  const sort: ReferenceOptionSort | undefined =
    sortField !== undefined
      ? { field: sortField, direction: sortDir }
      : sortParam === 'field'
        ? undefined
        : sortParam

  const flatSchema = branchContext.flatSchema
  const store = new ContentStore(branchContext.branchRoot, flatSchema, {
    contentRootName: ctx.services.config.contentRoot || 'content',
  })

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

  // Build the access checker once and pass it in as a filter *before* loading: a denied path is
  // skipped outright, so it never triggers the store.read() that would otherwise compute a label
  // for an option the caller isn't allowed to see.
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  const resolver = new ReferenceResolver(store, idIndex)
  const options = await resolver.loadReferenceOptions(
    collections,
    displayField,
    search,
    entryTypes,
    (logicalPath) => checkAccess(logicalPath, 'read').allowed,
    { seo: ctx.services.config.seo, sort },
  )

  return {
    ok: true,
    status: 200,
    data: { options },
  }
}

/**
 * Get reference options for a field
 * GET /:branch/reference-options
 * Query params: collections (comma-separated, optional), entryTypes (comma-separated, optional),
 *   displayField, search. At least one of collections or entryTypes is required. `sort` is
 *   label (default), collection or field; field takes `sortField` (a dotted path) and `sortDir`
 *   (asc, the default, or desc). See `ReferenceOptionSort`.
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
