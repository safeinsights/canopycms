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
import { canonicalizeTransformPath, type ParsedTransformPath } from '../assets/transform-directives'
import { storeTransform, TRANSFORM_CACHE_CONTROL } from '../assets/materialize'
import { isAdmin } from '../authorization/helpers'

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
type ListAssetsParams = z.infer<typeof listAssetsParamsSchema>

/** hash32 is a sha-256 truncated to 32 hex chars (keys.ts's `hashBytes`) - never any other shape. */
const hash32Schema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, 'key must be a 32-character lowercase hex string')

const deleteAssetParamsSchema = z.object({ key: hash32Schema })
type DeleteAssetParams = z.infer<typeof deleteAssetParamsSchema>

/**
 * Presign a direct (or proxied) upload target. Any authenticated user - there
 * is no finer "editor" role, and upload needs to work for every non-admin
 * user too (see guard semantics in .claude/future-tasks/resolved/assets-media-system.md).
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
 * Proxied upload for stores that don't support direct-to-storage presigning (LocalAssetStore in
 * dev). Reads multipart/form-data (a `file` part, optional `filename` override) instead of JSON;
 * this route sets `bodyFormat: 'multipart'` so the core handler skips its default `req.json()`
 * parse, since the body stream can only be read once (see http/handler.ts). Any authenticated
 * user (same rationale as presign/finalize).
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

  // Early size guard from Content-Length, before the multipart body is read - `formData()`/
  // `arrayBuffer()` below fully buffer the upload into memory, so without this an over-cap
  // request still pays the full read cost before the post-read check further down rejects it.
  // `beginUpload()` is the store-agnostic way to learn the store's max; filename/contentType here
  // are placeholders since only `.maxBytes` is read.
  const contentLengthHeader = req.rawRequest.header('content-length')
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader)
    if (Number.isFinite(contentLength)) {
      const { maxBytes } = await ctx.assetStore.beginUpload({
        filename: 'upload',
        contentType: 'application/octet-stream',
      })
      if (contentLength > maxBytes) {
        return { ok: false, status: 413, error: `File exceeds the ${maxBytes}-byte limit` }
      }
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
  // Defense-in-depth: the Content-Length guard above is the primary check
  // (it runs before the body is buffered at all) but a missing or lying
  // Content-Length header would skip it entirely, so the actual byte count
  // is still re-checked here against the same store-provided bound.
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
 * accepted: unlisted != private, see .claude/future-tasks/resolved/assets-media-system.md).
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
 * Delete asset - an Admin may delete any asset; anyone else may delete only an asset whose
 * recorded `uploadedBy` is them. `key` (hash32) is pre-validated by `deleteAssetParamsSchema`.
 * Deletes the meta sidecar only - blobs are immortal until a future GC worker task (see
 * .claude/future-tasks/resolved/assets-media-system.md).
 *
 * The ownership check lives here, not in a declarative guard, because it needs the asset's meta,
 * which guards can't read. Two fail-closed choices:
 * - Meta with no `uploadedBy` (the field is optional) is admin-only — defaulting to "anyone may
 *   delete" would open every legacy asset to everyone.
 * - A missing asset returns the same 403 as an unowned one for non-admins, so the endpoint isn't
 *   an existence oracle over a content-addressed keyspace.
 *
 * `uploadedBy` records the FIRST uploader only: finalizeAsset dedups on content hash, so a second
 * person uploading an identical file gains no delete rights over it — benign (a 403 where they
 * expected success, never the reverse; see
 * .claude/future-tasks/asset-listing-cross-branch-exposure.md).
 *
 * Coupled to the blob-GC follow-up in asset-review-followups.md: this permission is safe because
 * delete is a de-list, not a destroy — nothing another branch references breaks. If GC ever makes
 * delete destroy the blob, this needs a reference check too.
 */
const deleteAssetHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: DeleteAssetParams,
): Promise<AssetDeleteResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  if (!isAdmin(req.user.groups)) {
    const meta = await ctx.assetStore.getMeta(params.key)
    if (!meta?.uploadedBy || meta.uploadedBy !== req.user.userId) {
      return { ok: false, status: 403, error: 'You can only delete assets you uploaded' }
    }
  }

  await ctx.assetStore.deleteMeta(params.key)
  return { ok: true, status: 200, data: { deleted: true } }
}

/**
 * The largest body this route returns inline. The CMS Lambda's Function URL buffers its response
 * and caps it at 6 MiB after base64 encoding, which inflates by 4/3, so 4 MiB leaves headroom.
 * Same bound and reasoning as the transform Lambda's `INLINE_BODY_LIMIT_BYTES`.
 */
const INLINE_BODY_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * A 302 to a presigned store URL. `no-store` because the URL expires: a cached redirect would
 * outlive it, and a browser revisiting the page would follow it to a 403.
 */
function presignedRedirect(url: string): CanopyBinaryResponse {
  return {
    kind: 'binary',
    status: 302,
    body: new Uint8Array(),
    headers: { location: url, cacheControl: 'no-store' },
  }
}

/**
 * This route's own lazy transform: `storeTransform` computes and stores the output, then this
 * serves the bytes just computed. `parsed` is the canonical parse from `canonicalizeTransformPath`,
 * and `canonicalKey` already missed `rawAssetHandler`'s cache check.
 */
async function serveLazyTransform(
  assetStore: AssetStore,
  parsed: ParsedTransformPath,
  canonicalKey: string,
): Promise<CanopyBinaryResponse | ApiResponse<never>> {
  const transformed = await storeTransform(assetStore, parsed, canonicalKey)
  if (!transformed.ok) {
    // The real status, not a flat 502: none of these rejections is "this server failed".
    const error = transformed.status === 404 ? 'Not found' : transformed.error
    return { ok: false, status: transformed.status, error }
  }

  if (transformed.data.byteLength > INLINE_BODY_LIMIT_BYTES && assetStore.presignPublicObjectRead) {
    const url = await assetStore.presignPublicObjectRead(canonicalKey)
    if (url) return presignedRedirect(url)
  }

  return {
    kind: 'binary',
    status: 200,
    body: transformed.data,
    headers: { contentType: transformed.contentType, cacheControl: TRANSFORM_CACHE_CONTROL },
  }
}

/** A redirect to, or the bytes of, the public object stored at `key`; `null` when there is none. */
async function serveStoredObject(
  assetStore: AssetStore,
  key: string,
): Promise<CanopyBinaryResponse | null> {
  if (assetStore.presignPublicObjectRead) {
    const url = await assetStore.presignPublicObjectRead(key)
    return url ? presignedRedirect(url) : null
  }
  const object = await assetStore.readPublicObject(key)
  if (!object) return null
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

/**
 * Serve a public asset object (sanitized svg/pdf finalize wrote, or a cached transform output)
 * to the editor, the live preview, and `withCanopy`'s `/assets/*` rewrite. Hand-built (not
 * `defineEndpoint`), not registered in `ASSET_ROUTES`/the client generator: this returns raw bytes
 * (`CanopyBinaryResponse`), not a JSON envelope, so a generated `response.json()` client method
 * would be wrong. Consumers hit this route directly (`<img>`/`<a>` src, or a framework rewrite),
 * never through `client.ts`.
 *
 * A transform key (`assets/t/...`) is resolved to its canonical key first, and that key is what is
 * cache-checked and, on a miss, computed by `serveLazyTransform`. Mirrors `AssetSupport`'s lazy
 * mode (CloudFront origin-group -> S3 -> Lambda on miss), except that a non-canonical spelling is
 * served the canonical bytes rather than the Lambda's 301: this route is authenticated, and
 * redirecting to `/assets/t/...` would bounce the request onto the public path.
 *
 * A stored object on a store that can presign (S3) is answered with a 302 to a presigned GET, so
 * its bytes never pass through this process: the CMS Lambda is concurrency-capped and uncached,
 * the live preview asks for every image on a page at once, and its Function URL cannot return a
 * body over about 6 MiB. The redirect never targets the public `/assets/...` URL, because whether
 * that URL reaches this route again is topology: `withCanopy` rewrites `/assets/:path*` here, so
 * on any deployment where Next serves `/assets` the redirect would loop. Other stores stream the
 * bytes, as does a fresh transform no larger than `INLINE_BODY_LIMIT_BYTES`.
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

  let readKey = key
  let transform: ParsedTransformPath | undefined
  if (key.startsWith(transformPrefix)) {
    const canonical = canonicalizeTransformPath(key.slice(transformPrefix.length).split('/'), 'any')
    if (!canonical.ok) return { ok: false, status: 400, error: canonical.error }
    readKey = `${transformPrefix}${canonical.canonicalPath}`
    transform = canonical
  }

  const stored = await serveStoredObject(ctx.assetStore, readKey)
  if (stored) return stored

  if (!transform) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  return serveLazyTransform(ctx.assetStore, transform, readKey)
}

// Deliberately no 'writableBranch' guard on any endpoint below: none take a
// :branch param -- the asset store is branch-agnostic (a single global store,
// see assets/factory.ts), so the protected-base-branch predicate doesn't apply.

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
