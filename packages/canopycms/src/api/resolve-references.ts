import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContextWithSchema } from '../types'
import { ContentStore } from '../content-store'
import { defineEndpoint } from './route-builder'
import type { LogicalPath } from '../paths'
import { branchNameSchema, contentIdSchema } from './validators'

export interface ResolveReferencesBody {
  ids: string[] // ContentId strings at runtime
}

export type ResolveReferencesResponse = ApiResponse<{
  resolved: Record<string, unknown>
}>

/**
 * Resolution does sequential per-ID file I/O, so the request body caps how much filesystem work
 * a single caller can force. 100 is generous for real UI usage (a page's worth of reference
 * fields) while keeping worst-case latency/IO bounded (API-M1).
 */
const MAX_RESOLVE_REFERENCE_IDS = 100

const resolveReferencesParamsSchema = z.object({
  branch: branchNameSchema,
})

const resolveReferencesBodySchema = z.object({
  ids: z.array(contentIdSchema).min(1).max(MAX_RESOLVE_REFERENCE_IDS),
})

const resolveReferencesHandler = async (
  gc: { branchContext: BranchContextWithSchema },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof resolveReferencesParamsSchema>,
  body: z.infer<typeof resolveReferencesBodySchema>,
): Promise<ResolveReferencesResponse> => {
  const { branchContext } = gc

  const { ids } = body

  const store = new ContentStore(branchContext.branchRoot, branchContext.flatSchema, {
    contentRootName: ctx.services.config.contentRoot || 'content',
  })

  // Built once for every id. A failure here (e.g. settings workspace unavailable) surfaces as a
  // handler error rather than being swallowed per id.
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  const access = (logicalPath: LogicalPath) => checkAccess(logicalPath, 'read').allowed

  // The resolution `read()` applies to a reference field, so live preview shows this user what
  // `read()` would: the target's data, or a `RestrictedReference` for a target they may not
  // read. The target's own references stay ids, as in `read()`.
  const resolved: Record<string, unknown> = {}
  for (const id of ids) {
    try {
      const value = await store.resolveReferenceTarget(id, access)
      if (value) resolved[id] = value
    } catch (error) {
      // An id that fails to resolve is omitted rather than failing the whole request.
      console.error(`Failed to resolve reference ID ${id}:`, error)
    }
  }

  return {
    ok: true,
    status: 200,
    data: { resolved },
  }
}

/**
 * Resolve reference IDs as a reference field would: full target data, or title + URL tagged
 * `unavailable` for a target the user may not read. An id naming no entry is omitted.
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
  bodyType: 'ResolveReferencesBody',
  responseType: 'ResolveReferencesResponse',
  response: {} as ResolveReferencesResponse,
  defaultMockData: { resolved: {} },
  guards: ['branchAccessWithSchema'] as const,
  handler: resolveReferencesHandler,
})

/**
 * Exported routes for router registration
 */
export const RESOLVE_REFERENCES_ROUTES = {
  post: resolveReferences,
} as const
