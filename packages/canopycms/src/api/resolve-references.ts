import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { ContentStore } from '../content-store'
import { resolveBranchPaths } from '../paths'
import { defineEndpoint } from './route-builder'
import { ReferenceResolver } from '../reference-resolver'

/** Response type for resolved references */
export type ResolveReferencesResponse = ApiResponse<{
  resolved: Record<string, any>
}>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const resolveReferencesParamsSchema = z.object({
  branch: z.string().min(1),
})

const resolveReferencesBodySchema = z.object({
  ids: z.array(z.string()).min(1),
})

const resolveReferencesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof resolveReferencesParamsSchema>
): Promise<ResolveReferencesResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Parse and validate request body
  const bodyValidation = resolveReferencesBodySchema.safeParse(req.body)
  if (!bodyValidation.success) {
    return {
      ok: false,
      status: 400,
      error: `Invalid request body: ${bodyValidation.error.message}`,
    }
  }

  const { ids } = bodyValidation.data

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const store = new ContentStore(branchPaths.branchRoot, ctx.services.flatSchema)

  // Get ID index (automatically loads if needed)
  const idIndex = await store.idIndex()

  // Resolve each ID to full document
  const contentRoot = ctx.services.config.contentRoot ?? 'content'
  const resolver = new ReferenceResolver(store, idIndex, contentRoot)

  const resolved: Record<string, any> = {}

  for (const id of ids) {
    try {
      const result = await resolver.resolve(id)
      if (result && result.exists && result.collection && result.slug) {
        // Fetch full document data
        const doc = await store.read(result.collection, result.slug)
        if (doc && doc.data) {
          resolved[id] = {
            id,
            ...doc.data,
          }
        }
      }
    } catch (error) {
      // Skip failed resolutions, don't block entire request
      console.error(`Failed to resolve reference ID ${id}:`, error)
    }
  }

  return {
    ok: true,
    status: 200,
    data: { resolved },
  }
}

// ============================================================================
// Route Definitions
// ============================================================================

/**
 * Resolve reference IDs to full document objects
 * POST /:branch/resolve-references
 * Body: { ids: string[] }
 */
const resolveReferences = defineEndpoint({
  namespace: 'content',
  name: 'resolveReferences',
  method: 'POST',
  path: '/:branch/resolve-references',
  params: resolveReferencesParamsSchema,
  body: resolveReferencesBodySchema,
  responseType: 'ResolveReferencesResponse',
  response: {} as ResolveReferencesResponse,
  defaultMockData: { resolved: {} },
  handler: resolveReferencesHandler,
})

/**
 * Exported routes for router registration
 */
export const RESOLVE_REFERENCES_ROUTES = {
  post: resolveReferences,
} as const
