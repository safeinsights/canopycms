import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { ContentStore, ContentStoreError } from '../content-store'
import type { ContentFormat } from '../config'
import { resolveBranchWorkspace } from '../paths'

export interface ReadContentParams {
  branch: string
  collection: string
  slug?: string
}

export const readContent = async (
  ctx: ApiContext,
  req: ApiRequest<undefined>,
  params: ReadContentParams
): Promise<ApiResponse> => {
  const branchState = await ctx.getBranchState(params.branch)
  if (!branchState) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(branchState, branchMode)
  const store = new ContentStore(branchPaths.branchRoot, ctx.services.config)
  let relativePath: string
  try {
    relativePath = store.resolveDocumentPath(params.collection, params.slug ?? '').relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  const access = ctx.services.checkContentAccess(branchState, relativePath, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const doc = await store.read(params.collection, params.slug ?? '')
  return { ok: true, status: 200, data: doc }
}

export interface WriteContentBody {
  collection: string
  slug?: string
  format: ContentFormat
  data?: Record<string, unknown>
  body?: string
}

export const writeContent = async (
  ctx: ApiContext,
  req: ApiRequest<WriteContentBody>
): Promise<ApiResponse> => {
  if (!req.body?.collection || !req.branch) {
    return { ok: false, status: 400, error: 'collection and branch are required' }
  }
  const branchState = await ctx.getBranchState(req.branch)
  if (!branchState) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(branchState, branchMode)
  const store = new ContentStore(branchPaths.branchRoot, ctx.services.config)
  let relativePath: string
  try {
    relativePath = store.resolveDocumentPath(req.body.collection, req.body.slug ?? '').relativePath
  } catch (err) {
    const message = err instanceof ContentStoreError ? err.message : 'Invalid content request'
    return { ok: false, status: 400, error: message }
  }

  const access = ctx.services.checkContentAccess(branchState, relativePath, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const result =
    req.body.format === 'json'
      ? await store.write(req.body.collection, req.body.slug ?? '', {
          format: 'json',
          data: req.body.data ?? {},
        })
      : await store.write(req.body.collection, req.body.slug ?? '', {
          format: req.body.format,
          data: req.body.data,
          body: req.body.body ?? '',
        })

  return { ok: true, status: 200, data: result }
}
