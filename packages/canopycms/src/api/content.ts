import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { ContentStore, ContentStoreError } from '../content-store'
import type { ContentFormat } from '../config'
import { resolveBranchPaths } from '../paths'
import { defineEndpoint } from './route-builder'

/** Response type for content read operations */
export type ContentReadResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
}>

/** Response type for content write operations */
export type ContentWriteResponse = ApiResponse<{
  format: string
  data: Record<string, unknown>
  body?: string
}>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const readContentParamsSchema = z.object({
  branch: z.string().min(1),
  collection: z.string().min(1),
  slug: z.string().optional(),
})

const writeContentParamsSchema = z.object({
  branch: z.string().min(1),
  collection: z.string().min(1),
  slug: z.string().optional(),
})

const writeContentBodySchema = z.object({
  format: z.enum(['json', 'md', 'mdx']),
  data: z.record(z.unknown()).optional(),
  body: z.string().optional(),
})

export interface ReadContentParams {
  branch: string
  collection: string
  slug?: string
}

const readContentHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof readContentParamsSchema>
): Promise<ContentReadResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const store = new ContentStore(branchPaths.branchRoot, ctx.services.config)

  // Prepend contentRoot to collection if not already present
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const fullCollection = params.collection.startsWith(contentRoot + '/')
    ? params.collection
    : `${contentRoot}/${params.collection}`

  let relativePath: string
  try {
    relativePath = store.resolveDocumentPath(fullCollection, params.slug ?? '').relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  const access = await ctx.services.checkContentAccess(context, branchPaths.branchRoot, relativePath, req.user, 'read')
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const doc = await store.read(fullCollection, params.slug ?? '')
  return { ok: true, status: 200, data: doc }
}

export interface WriteContentBody {
  collection: string
  slug?: string
  format: ContentFormat
  data?: Record<string, unknown>
  body?: string
}

const writeContentHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof writeContentParamsSchema>,
  body: z.infer<typeof writeContentBodySchema>
): Promise<ContentWriteResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const store = new ContentStore(branchPaths.branchRoot, ctx.services.config)

  // Prepend contentRoot to collection if not already present
  const contentRoot = ctx.services.config.contentRoot || 'content'
  const fullCollection = params.collection.startsWith(contentRoot + '/')
    ? params.collection
    : `${contentRoot}/${params.collection}`

  let relativePath: string
  try {
    relativePath = store.resolveDocumentPath(fullCollection, params.slug ?? '').relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  const access = await ctx.services.checkContentAccess(context, branchPaths.branchRoot, relativePath, req.user, 'edit')
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  try {
    const result =
      body.format === 'json'
        ? await store.write(fullCollection, params.slug ?? '', {
            format: 'json',
            data: body.data ?? {},
          })
        : await store.write(fullCollection, params.slug ?? '', {
            format: body.format,
            data: body.data,
            body: body.body ?? '',
          })

    return { ok: true, status: 200, data: result }
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Write failed'
    return { ok: false, status: 400, error: message }
  }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * Read content from a collection
 * GET /:branch/content/:collection/:slug
 */
const readContent = defineEndpoint({
  namespace: 'content',
  name: 'read',
  method: 'GET',
  path: '/:branch/content/:collection/...slug',
  params: readContentParamsSchema,
  responseType: 'ContentReadResponse',
  response: {} as ContentReadResponse,
  defaultMockData: { format: 'json', data: {} },
  handler: readContentHandler,
})

/**
 * Write content to a collection
 * PUT /:branch/content/:collection/:slug
 */
const writeContent = defineEndpoint({
  namespace: 'content',
  name: 'write',
  method: 'PUT',
  path: '/:branch/content/:collection/...slug',
  params: writeContentParamsSchema,
  body: writeContentBodySchema,
  responseType: 'ContentWriteResponse',
  response: {} as ContentWriteResponse,
  defaultMockData: { format: 'json', data: {} },
  handler: writeContentHandler,
})

/**
 * Exported routes for router registration
 */
export const CONTENT_ROUTES = {
  read: readContent,
  write: writeContent,
} as const
