import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import type { AssetMeta } from '../assets/types'

/** Response type for listing assets */
export type AssetsListResponse = ApiResponse<{ assets: AssetMeta[]; nextCursor?: string }>

/**
 * Response type for uploading an asset. The upload endpoint is a stub in
 * this PR (always 501) — the real presign/finalize response shape lands
 * with the asset API in a later PR.
 */
export type AssetUploadResponse = ApiResponse<{
  asset: { key: string; url?: string }
}>

/** Response type for deleting an asset */
export type AssetDeleteResponse = ApiResponse<{ deleted: boolean }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const uploadAssetBodySchema = z.object({
  key: z.string().min(1),
  contentType: z.string().optional(),
  data: z.instanceof(Buffer).or(z.instanceof(Uint8Array)),
})

export interface UploadAssetBody {
  key: string
  contentType?: string
  data: Buffer | Uint8Array
}

export interface ListAssetsParams {
  cursor?: string
  limit?: number
}

export interface DeleteAssetBody {
  key: string
}

/**
 * List assets - any authenticated user can list assets (key enumeration is
 * accepted: unlisted != private, see assets-media-system.md).
 *
 * Declared as `params` (not just parsed ad hoc from req.query) so the client
 * generator (scripts/generate-client.ts) sees a paramsSchema and emits a
 * method that accepts and forwards `cursor`/`limit` (API-H4) instead of a
 * no-arg `assets.list()` that can never pass them.
 */
const listAssetsParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})

const listAssetsHandler = async (ctx: ApiContext, req: ApiRequest): Promise<AssetsListResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }
  const query = listAssetsParamsSchema.safeParse(req.query ?? {})
  if (!query.success) {
    return { ok: false, status: 400, error: query.error.message }
  }
  const { items, nextCursor } = await ctx.assetStore.listMeta({
    cursor: query.data.cursor,
    limit: query.data.limit,
  })
  return { ok: true, status: 200, data: { assets: items, nextCursor } }
}

/**
 * Upload asset - stub for this PR. The store contract (presigned direct
 * upload / proxied staging write, magic-byte sniff, hashing, dimension
 * extraction) is finalized in a later PR (see epic breakdown in
 * .claude/future-tasks/assets-media-system.md); this endpoint intentionally
 * always returns 501 so the route + guard exist without a half-built upload
 * path. The guard stays `privileged` for now — the design decision to widen
 * this to any authenticated user for editors lands with the real endpoint.
 */
const uploadAssetHandler = async (
  _gc: Record<string, never>,
  _ctx: ApiContext,
  _req: ApiRequest,
  _body: z.infer<typeof uploadAssetBodySchema>,
): Promise<AssetUploadResponse> => {
  return {
    ok: false,
    status: 501,
    error: 'Direct upload not implemented yet; presign/finalize arrives in a later PR',
  }
}

/**
 * Delete asset - requires Admin access. `key` is the asset's hash32.
 *
 * Declared as `params` (see listAssetsParamsSchema above) so the generated
 * client's `assets.delete()` method accepts and forwards `key` (API-H4).
 */
const deleteAssetParamsSchema = z.object({ key: z.string().min(1) })

const deleteAssetHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  req: ApiRequest,
): Promise<AssetDeleteResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  const deleteQuery = deleteAssetParamsSchema.safeParse(req.query ?? {})
  if (!deleteQuery.success) {
    return { ok: false, status: 400, error: 'key query parameter required' }
  }

  await ctx.assetStore.deleteMeta(deleteQuery.data.key)
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
  params: listAssetsParamsSchema,
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
  bodyType: 'UploadAssetBody',
  responseType: 'AssetUploadResponse',
  response: {} as AssetUploadResponse,
  defaultMockData: { asset: { key: '', url: '' } },
  guards: ['privileged'] as const,
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
  params: deleteAssetParamsSchema,
  responseType: 'AssetDeleteResponse',
  response: {} as AssetDeleteResponse,
  defaultMockData: { deleted: true },
  guards: ['admin'] as const,
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
