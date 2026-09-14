import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContextWithSchema } from '../types'
import { ContentStore } from '../content-store'
import { defineEndpoint } from './route-builder'
import { ReferenceResolver } from '../reference-resolver'
import { buildResolvedReference } from '../entry-schema'
import { computeEntryUrl } from '../utils/entry-url'
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

  const flatSchema = branchContext.flatSchema
  const contentRootName = ctx.services.config.contentRoot || 'content'
  const store = new ContentStore(branchContext.branchRoot, flatSchema, {
    contentRootName,
  })

  // Get ID index (automatically loads if needed)
  const idIndex = await store.idIndex()

  // Resolve each ID to full document
  const resolver = new ReferenceResolver(store, idIndex)

  // Build the access checker once, reused for every id instead of re-loading per id in the loop.
  // A failure here (e.g. settings workspace unavailable) surfaces as a handler error, not
  // swallowed silently per id.
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )

  const resolved: Record<string, unknown> = {}

  for (const id of ids) {
    try {
      const result = await resolver.resolve(id)
      if (result && result.exists && result.collection && result.slug) {
        // Check path-level read permission before returning content
        const resolvedPath = await store.resolveDocumentPath(result.collection, result.slug)
        const access = checkAccess(resolvedPath.relativePath, 'read')
        if (!access.allowed) continue

        // `resolveReferences: false` matches the server-side resolver (content-store.ts's
        // resolveSingleReferenceOnce), so a nested reference inside a target renders the same way
        // in live preview as on the published site, instead of resolving one level deeper.
        const doc = await store.read(result.collection, result.slug, { resolveReferences: false })
        if (doc && doc.data) {
          // Same shape as the server-side resolver: target data first, then the reserved keys.
          // Order is the corruption guard (a target modelling `id` as content must not shadow the
          // real content ID); the extra keys (incl. `urlPath`) keep live preview and production
          // in sync for consumers like client-reference-resolver.ts.
          resolved[id] = buildResolvedReference(doc.data, {
            id,
            slug: result.slug,
            collection: result.collection,
            urlPath: computeEntryUrl(result.collection, result.slug, contentRootName),
          })
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
