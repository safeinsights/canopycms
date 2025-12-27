import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { isAdmin, isPrivileged } from '../reserved-groups'

export interface ListAssetsParams {
  prefix?: string
}

/**
 * List assets - any authenticated user can list assets.
 */
export const listAssets = async (
  ctx: ApiContext,
  _req: ApiRequest,
  params: ListAssetsParams = {},
): Promise<ApiResponse<{ assets: { key: string; url?: string }[] }>> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }
  const assets = await ctx.assetStore.list(params.prefix ?? '')
  return { ok: true, status: 200, data: { assets } }
}

export interface UploadAssetBody {
  key: string
  contentType?: string
  data: Buffer | Uint8Array
}

/**
 * Upload asset - requires privileged access (Admin or Reviewer).
 */
export const uploadAsset = async (
  ctx: ApiContext,
  req: ApiRequest<UploadAssetBody>,
): Promise<ApiResponse<{ asset: { key: string; url?: string } }>> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  // Require privileged access to upload assets
  if (!isPrivileged(req.user.groups)) {
    return { ok: false, status: 403, error: 'Only Admins and Reviewers can upload assets' }
  }

  if (!req.body?.key || !req.body?.data) {
    return { ok: false, status: 400, error: 'key and data required' }
  }
  const asset = await ctx.assetStore.upload(req.body.key, req.body.data, req.body.contentType)
  return { ok: true, status: 200, data: { asset } }
}

export interface DeleteAssetBody {
  key: string
}

/**
 * Delete asset - requires Admin access.
 */
export const deleteAsset = async (
  ctx: ApiContext,
  req: ApiRequest<DeleteAssetBody>,
): Promise<ApiResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  // Require admin access to delete assets
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Only Admins can delete assets' }
  }

  if (!req.body?.key) return { ok: false, status: 400, error: 'key required' }
  await ctx.assetStore.delete(req.body.key)
  return { ok: true, status: 200 }
}
