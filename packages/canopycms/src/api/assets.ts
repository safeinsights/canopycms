import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { isAdmin, isPrivileged } from '../reserved-groups'
import { defineEndpoint } from './route-builder'

/** Response type for listing assets */
export type AssetsListResponse = ApiResponse<{ assets: { key: string; url?: string }[] }>

/** Response type for uploading an asset */
export type AssetUploadResponse = ApiResponse<{ asset: { key: string; url?: string } }>

/** Response type for deleting an asset */
export type AssetDeleteResponse = ApiResponse<{ deleted: boolean }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const uploadAssetBodySchema = z.object({
  key: z.string().min(1),
  contentType: z.string().optional(),
  data: z.instanceof(Buffer).or(z.instanceof(Uint8Array))
})

export interface ListAssetsParams {
  prefix?: string
}

export interface UploadAssetBody {
  key: string
  contentType?: string
  data: Buffer | Uint8Array
}

export interface DeleteAssetBody {
  key: string
}

/**
 * List assets - any authenticated user can list assets.
 */
const listAssetsHandler = async (
  ctx: ApiContext,
  req: ApiRequest
): Promise<AssetsListResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }
  const prefix = req.query?.prefix as string | undefined
  const assets = await ctx.assetStore.list(prefix ?? '')
  return { ok: true, status: 200, data: { assets } }
}

/**
 * Upload asset - requires privileged access (Admin or Reviewer).
 */
const uploadAssetHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof uploadAssetBodySchema>
): Promise<AssetUploadResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  // Require privileged access to upload assets
  if (!isPrivileged(req.user.groups)) {
    return { ok: false, status: 403, error: 'Only Admins and Reviewers can upload assets' }
  }

  const asset = await ctx.assetStore.upload(body.key, body.data, body.contentType)
  return { ok: true, status: 200, data: { asset } }
}

/**
 * Delete asset - requires Admin access.
 */
const deleteAssetHandler = async (
  ctx: ApiContext,
  req: ApiRequest
): Promise<AssetDeleteResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  // Require admin access to delete assets
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Only Admins can delete assets' }
  }

  const key = req.query?.key as string | undefined
  if (!key) {
    return { ok: false, status: 400, error: 'key query parameter required' }
  }

  await ctx.assetStore.delete(key)
  return { ok: true, status: 200, data: { deleted: true } }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * List all assets
 * GET /assets
 */
const listAssets = defineEndpoint({
  namespace: 'assets',
  name: 'list',
  method: 'GET',
  path: '/assets',
  responseType: 'AssetsListResponse',
  response: {} as AssetsListResponse,
  defaultMockData: { assets: [] },
  handler: listAssetsHandler,
})

/**
 * Upload an asset
 * POST /assets
 */
const uploadAsset = defineEndpoint({
  namespace: 'assets',
  name: 'upload',
  method: 'POST',
  path: '/assets',
  body: uploadAssetBodySchema,
  responseType: 'AssetUploadResponse',
  response: {} as AssetUploadResponse,
  defaultMockData: { asset: { key: '', url: '' } },
  handler: uploadAssetHandler,
})

/**
 * Delete an asset
 * DELETE /assets?key=...
 */
const deleteAsset = defineEndpoint({
  namespace: 'assets',
  name: 'delete',
  method: 'DELETE',
  path: '/assets',
  responseType: 'AssetDeleteResponse',
  response: {} as AssetDeleteResponse,
  defaultMockData: { deleted: true },
  handler: deleteAssetHandler,
})

/**
 * Exported routes for router registration
 */
export const ASSET_ROUTES = {
  list: listAssets,
  upload: uploadAsset,
  delete: deleteAsset,
} as const
