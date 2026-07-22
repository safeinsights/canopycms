import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import type { RouteDefinition } from '../http/router'
import type { CanopyBinaryResponse } from '../http/types'
import type { AssetMeta, AssetStore, StagedUploadTarget } from '../assets/types'
import { ASSET_PREFIXES } from '../assets/keys'
import { ALLOWED_UPLOAD_CONTENT_TYPES } from '../assets/pipeline'
import { finalizeStagedUpload } from '../assets/finalize'
import { assetSrc } from '../assets/asset-src'
import { formatDirectives, parseTransformPath } from '../assets/transform-directives'
import { applyTransform } from '../assets/transform'

/** An asset's persisted meta plus its computed, root-relative public URL. */
export type AssetRecord = AssetMeta & { src: string }

function toAssetRecord(meta: AssetMeta): AssetRecord {
  return { ...meta, src: assetSrc(meta) }
}

const MOCK_ASSET_RECORD: AssetRecord = {
  hash32: 'a'.repeat(32),
  filename: 'sample.png',
  slug: 'sample',
  ext: 'png',
  mime: 'image/png',
  size: 1024,
  width: 100,
  height: 100,
  kind: 'raster',
  uploadedAt: '2024-01-01T00:00:00.000Z',
  src: '/assets/t/orig/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sample.png',
}

/** Response type for listing assets */
export type AssetsListResponse = ApiResponse<{ assets: AssetRecord[]; nextCursor?: string }>

/** Response type for presigning an upload */
export type PresignAssetResponse = ApiResponse<{ upload: StagedUploadTarget }>

/** Response type for finalizing (or proxy-uploading) an asset */
export type FinalizeAssetResponse = ApiResponse<{ asset: AssetRecord }>

/** Response type for deleting an asset */
export type AssetDeleteResponse = ApiResponse<{ deleted: boolean }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const filenameSchema = z.string().min(1).max(255)

const presignAssetBodySchema = z.object({
  filename: filenameSchema,
  contentType: z.string().min(1),
  size: z.number().int().positive().optional(),
})
export type PresignAssetBody = z.infer<typeof presignAssetBodySchema>

const finalizeAssetBodySchema = z.object({
  stagingKey: z.string().min(1),
  filename: filenameSchema,
})
export type FinalizeAssetBody = z.infer<typeof finalizeAssetBodySchema>

/**
 * Declared as `params` (not just parsed ad hoc from req.query) so the client
 * generator (scripts/generate-client.ts) sees a paramsSchema and emits a
 * method that accepts and forwards `cursor`/`limit` (API-H4) instead of a
 * no-arg `assets.list()` that can never pass them.
 */
const listAssetsParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})
export type ListAssetsParams = z.infer<typeof listAssetsParamsSchema>

/** hash32 is a sha-256 truncated to 32 hex chars (keys.ts's `hashBytes`) - never any other shape. */
const hash32Schema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, 'key must be a 32-character lowercase hex string')

const deleteAssetParamsSchema = z.object({ key: hash32Schema })
export type DeleteAssetParams = z.infer<typeof deleteAssetParamsSchema>

// ============================================================================
// Handlers
// ============================================================================

/**
 * Presign a direct (or proxied) upload target. Any authenticated user - there
 * is no finer "editor" role, and upload needs to work for every non-admin
 * user too (see guard semantics in .claude/future-tasks/assets-media-system.md).
 */
const presignAssetHandler = async (
  ctx: ApiContext,
  _req: ApiRequest,
  body: PresignAssetBody,
): Promise<PresignAssetResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(body.contentType)) {
    return { ok: false, status: 415, error: `Unsupported content type: ${body.contentType}` }
  }

  const target = await ctx.assetStore.beginUpload({
    filename: body.filename,
    contentType: body.contentType,
    size: body.size,
  })

  // The client-declared size is only a fast, up-front UX check - the store's
  // own presigned target (S3's content-length-range condition, or the local
  // store's own cap) is what actually enforces the limit at upload time.
  if (body.size !== undefined && body.size > target.maxBytes) {
    return { ok: false, status: 413, error: `File exceeds the ${target.maxBytes}-byte limit` }
  }

  return { ok: true, status: 200, data: { upload: target } }
}

/**
 * Finalize a staged upload: read the staged bytes, run the finalize pipeline
 * (sniff/hash/dims/sanitize), write originals + meta, and return the result.
 * Any authenticated user (same rationale as presign).
 */
const finalizeAssetHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: FinalizeAssetBody,
): Promise<FinalizeAssetResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  const result = await finalizeStagedUpload(
    ctx.assetStore,
    body.stagingKey,
    body.filename,
    req.user.userId,
  )

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error }
  }

  return { ok: true, status: 200, data: { asset: toAssetRecord(result.meta) } }
}

/**
 * Proxied upload for stores that don't support direct-to-storage presigning
 * (LocalAssetStore in dev). Reads a multipart/form-data body (a `file` part,
 * plus an optional `filename` field overriding `file.name`) rather than JSON -
 * this route sets `bodyFormat: 'multipart'` below so the core handler skips
 * its default `req.json()` parsing, since the body stream can only be read
 * once (see http/handler.ts). Any authenticated user (same rationale as
 * presign/finalize).
 */
const uploadProxiedHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
): Promise<FinalizeAssetResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  if (ctx.assetStore.capabilities.directUpload) {
    return {
      ok: false,
      status: 400,
      error: 'This asset store supports direct upload - use POST /assets/presign instead',
    }
  }

  if (!req.rawRequest?.formData) {
    return {
      ok: false,
      status: 400,
      error: 'This server adapter does not support multipart form-data uploads',
    }
  }

  let formData: FormData
  try {
    formData = await req.rawRequest.formData()
  } catch {
    return { ok: false, status: 400, error: 'Could not parse multipart form-data body' }
  }

  const filePart = formData.get('file')
  if (!(filePart instanceof Blob)) {
    return { ok: false, status: 400, error: 'A "file" part is required' }
  }

  const filenameOverride = formData.get('filename')
  const filename =
    typeof filenameOverride === 'string' && filenameOverride.length > 0
      ? filenameOverride
      : filePart instanceof File
        ? filePart.name
        : 'upload'

  const data = new Uint8Array(await filePart.arrayBuffer())

  const target = await ctx.assetStore.beginUpload({
    filename,
    contentType: filePart.type || 'application/octet-stream',
    size: data.byteLength,
  })
  if (data.byteLength > target.maxBytes) {
    return { ok: false, status: 413, error: `File exceeds the ${target.maxBytes}-byte limit` }
  }

  await ctx.assetStore.writeStaging(target.stagingKey, data, filePart.type || undefined)

  const result = await finalizeStagedUpload(
    ctx.assetStore,
    target.stagingKey,
    filename,
    req.user.userId,
  )
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error }
  }

  return { ok: true, status: 200, data: { asset: toAssetRecord(result.meta) } }
}

/**
 * List assets - any authenticated user can list assets (key enumeration is
 * accepted: unlisted != private, see assets-media-system.md).
 */
const listAssetsHandler = async (
  ctx: ApiContext,
  _req: ApiRequest,
  params: ListAssetsParams,
): Promise<AssetsListResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  const { items, nextCursor } = await ctx.assetStore.listMeta({
    cursor: params.cursor,
    limit: params.limit,
  })
  return { ok: true, status: 200, data: { assets: items.map(toAssetRecord), nextCursor } }
}

/**
 * Delete asset - requires Admin access. `key` is the asset's hash32 and is
 * validated (32 lowercase hex chars) by `deleteAssetParamsSchema` before this
 * handler ever runs. Deletes the meta sidecar only - blobs are immortal until
 * a future GC worker task (see assets-media-system.md).
 */
const deleteAssetHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
  params: DeleteAssetParams,
): Promise<AssetDeleteResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  await ctx.assetStore.deleteMeta(params.key)
  return { ok: true, status: 200, data: { deleted: true } }
}

/** Cache-Control applied to every transform output this route writes/serves - matches finalize.ts's PUBLIC_CACHE_CONTROL for static public objects. */
const TRANSFORM_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Lazy dev-mode emulation of the prod transform Lambda (PR 7 reuses
 * `parseTransformPath`/`formatDirectives`/`applyTransform` unchanged): parse
 * the request, load the original, transform it, write the result back under
 * its CANONICAL key (so a non-canonically-ordered directive string still
 * dedupes with any equivalent request), then serve the bytes just computed
 * (no re-read from the store).
 *
 * `key` here is the full store key already confirmed to start with the
 * `assets/t/` prefix and to have missed the cache-hit `readPublicObject`
 * check in `rawAssetHandler`.
 */
async function serveLazyTransform(
  assetStore: AssetStore,
  key: string,
): Promise<CanopyBinaryResponse | ApiResponse<never>> {
  const rest = key.slice(ASSET_PREFIXES.transform.length + 1)
  const parsed = parseTransformPath(rest.split('/'))
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error }
  }

  const meta = await assetStore.getMeta(parsed.hash32)
  if (!meta) {
    return { ok: false, status: 404, error: 'Not found' }
  }
  if (meta.kind !== 'raster') {
    return { ok: false, status: 400, error: 'Not a raster asset - svg/pdf are served statically' }
  }

  // When the URL omits an explicit `f=` format, the transform preserves the
  // source format, so the URL's `{ext}` must match the source's real ext
  // exactly - the parser alone can't check this (it doesn't know the source
  // format until this meta lookup).
  const requestedFormat = parsed.directives.identity ? undefined : parsed.directives.format
  if (requestedFormat === undefined && parsed.ext !== meta.ext) {
    return { ok: false, status: 400, error: 'Extension does not match the source format' }
  }

  const original = await assetStore.readOriginal(parsed.hash32)
  if (!original) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  const transformed = await applyTransform(
    { data: original.data, ext: original.ext },
    parsed.directives,
  )
  if (!transformed.ok) {
    return { ok: false, status: 502, error: transformed.error }
  }

  const canonicalKey = `${ASSET_PREFIXES.transform}/${formatDirectives(parsed.directives)}/${parsed.hash32}/${parsed.slug}.${parsed.ext}`
  await assetStore.putPublicObject({
    key: canonicalKey,
    data: transformed.data,
    contentType: transformed.contentType,
    cacheControl: TRANSFORM_CACHE_CONTROL,
  })

  return {
    kind: 'binary',
    status: 200,
    body: transformed.data,
    headers: { contentType: transformed.contentType, cacheControl: TRANSFORM_CACHE_CONTROL },
  }
}

/**
 * Serve a public asset object (sanitized svg/pdf finalize wrote, or a
 * previously-computed transform output) for dev-mode `/assets/*` rewrites.
 * Hand-built (not `defineEndpoint`) rather than registered in
 * `ASSET_ROUTES`/the client generator: this route returns raw bytes
 * (`CanopyBinaryResponse`), not a JSON envelope, so a generated client
 * method that calls `response.json()` would be actively wrong. Consumers hit
 * this route directly (an `<img>`/`<a>` src, or a framework rewrite), never
 * through `client.ts`.
 *
 * Transform outputs (`assets/t/...`) are cache-checked exactly like any
 * other public object first - only a MISS under the `assets/t/` prefix falls
 * through to `serveLazyTransform`, which computes and caches the bytes. This
 * mirrors the prod design (CloudFront origin-group -> S3 -> Lambda on miss).
 */
const rawAssetHandler = async (
  ctx: ApiContext,
  _req: ApiRequest,
  params: Record<string, string>,
): Promise<CanopyBinaryResponse | ApiResponse<never>> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  const key = params.key ?? ''
  const publicPrefix = `${ASSET_PREFIXES.public}/`
  const transformPrefix = `${ASSET_PREFIXES.transform}/`
  // Defense-in-depth: the local store re-guards path traversal on its own key
  // resolution, but reject obviously-wrong keys before ever touching the
  // store, and never distinguish "malformed key" from "not found" in the
  // response (no oracle for probing).
  if (!key.startsWith(publicPrefix) || key.includes('..')) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  const object = await ctx.assetStore.readPublicObject(key)
  if (object) {
    return {
      kind: 'binary',
      status: 200,
      body: object.data,
      headers: {
        contentType: object.contentType,
        contentDisposition: object.contentDisposition,
        cacheControl: object.cacheControl,
      },
    }
  }

  if (!key.startsWith(transformPrefix)) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  return serveLazyTransform(ctx.assetStore, key)
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * POST /assets/presign
 */
const presignAsset = defineEndpoint({
  namespace: 'assets',
  name: 'presign',
  method: 'POST',
  path: '/assets/presign',
  body: presignAssetBodySchema,
  bodyType: 'PresignAssetBody',
  responseType: 'PresignAssetResponse',
  response: {} as PresignAssetResponse,
  defaultMockData: {
    upload: { mode: 'proxied', stagingKey: 'asset-staging/mock', maxBytes: 52428800 },
  },
  handler: presignAssetHandler,
})

/**
 * POST /assets/finalize
 */
const finalizeAsset = defineEndpoint({
  namespace: 'assets',
  name: 'finalize',
  method: 'POST',
  path: '/assets/finalize',
  body: finalizeAssetBodySchema,
  bodyType: 'FinalizeAssetBody',
  responseType: 'FinalizeAssetResponse',
  response: {} as FinalizeAssetResponse,
  defaultMockData: { asset: MOCK_ASSET_RECORD },
  handler: finalizeAssetHandler,
})

/**
 * POST /assets/upload (proxied, multipart/form-data - dev/local-store only)
 */
const uploadProxied = defineEndpoint({
  namespace: 'assets',
  name: 'uploadProxied',
  method: 'POST',
  path: '/assets/upload',
  bodyFormat: 'multipart',
  responseType: 'FinalizeAssetResponse',
  response: {} as FinalizeAssetResponse,
  defaultMockData: { asset: MOCK_ASSET_RECORD },
  handler: uploadProxiedHandler,
})

/**
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
 * DELETE /assets?key={hash32}
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
 * Exported routes for router registration and client codegen.
 */
export const ASSET_ROUTES = {
  presign: presignAsset,
  finalize: finalizeAsset,
  uploadProxied,
  list: listAssets,
  delete: deleteAsset,
} as const

/**
 * GET /assets/raw/{key...} - see `rawAssetHandler` above for why this is
 * registered separately from `ASSET_ROUTES` instead of through defineEndpoint.
 */
export const assetRawRoute: RouteDefinition = {
  method: 'GET',
  pattern: ['assets', 'raw', '...key'],
  handler: rawAssetHandler,
}
