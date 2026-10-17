import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import type { RouteDefinition } from '../http/router'
import type { CanopyBinaryResponse } from '../http/types'
import type {
  AssetStore,
  ListedAssetMeta,
  PresignedRead,
  StagedUploadTarget,
} from '../assets/types'
import { ASSET_PREFIXES } from '../assets/keys'
import { ALLOWED_UPLOAD_CONTENT_TYPES } from '../assets/pipeline'
import { finalizeStagedUpload } from '../assets/finalize'
import { assetSrc } from '../assets/asset-src'
import { canonicalizeTransformPath, type ParsedTransformPath } from '../assets/transform-directives'
import { storeTransform, TRANSFORM_CACHE_CONTROL } from '../assets/materialize'
import { isAdmin } from '../authorization/helpers'

/** An asset's persisted meta plus its computed, root-relative public URL. */
export type AssetRecord = ListedAssetMeta & { src: string }

function toAssetRecord(meta: ListedAssetMeta): AssetRecord {
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

/** Response type for removing a file from the library or restoring it: whether it is now hidden */
export type AssetVisibilityResponse = ApiResponse<{ hidden: boolean }>

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
  /** Admin only: also list files removed from the library, each marked `hidden: true`. */
  includeHidden: z.enum(['true', 'false']).optional(),
})
type ListAssetsParams = z.infer<typeof listAssetsParamsSchema>

/** hash32 is a sha-256 truncated to 32 hex chars (keys.ts's `hashBytes`) - never any other shape. */
const hash32Schema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, 'key must be a 32-character lowercase hex string')

const assetKeyBodySchema = z.object({ key: hash32Schema })
export type AssetKeyBody = z.infer<typeof assetKeyBodySchema>

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
 * Any authenticated user (same rationale as presign). Uploading a file that was
 * removed from the library puts it back; `finalizeAsset` says why.
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
 * Files removed from the library are left out; only an admin may ask for them too.
 */
const listAssetsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: ListAssetsParams,
): Promise<AssetsListResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  const includeHidden = params.includeHidden === 'true'
  if (includeHidden && !isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Only admins can list removed files' }
  }

  const { items, nextCursor } = await ctx.assetStore.listMeta({
    cursor: params.cursor,
    limit: params.limit,
    includeHidden,
  })
  return { ok: true, status: 200, data: { assets: items.map(toAssetRecord), nextCursor } }
}

/**
 * Who may remove a file from the library or restore it: an admin may act on any file; anyone else
 * only on a file whose recorded `uploadedBy` is them. `null` when the caller may act.
 *
 * The check lives here, not in a declarative guard, because it needs the asset's meta, which
 * guards can't read. Two fail-closed choices:
 * - Meta with no `uploadedBy` (the field is optional) is admin-only — defaulting to "anyone may
 *   act" would open every legacy asset to everyone.
 * - A missing asset returns the same 403 as an unowned one for non-admins, so the endpoint isn't
 *   an existence oracle over a content-addressed keyspace. An admin, who can list every file,
 *   gets a 404, so no marker is ever written for a file that does not exist.
 *
 * `uploadedBy` records the FIRST uploader only: finalizeAsset dedups on content hash, so a second
 * person uploading an identical file gains no rights over it — benign (a 403 where they expected
 * success, never the reverse; see safeinsights/canopycms#572).
 *
 * Coupled to the blob-GC follow-up in safeinsights/canopycms#575: this permission is safe because
 * removal hides a file and destroys nothing, so nothing any branch or build references breaks. If
 * GC ever deletes blobs, it needs a reference check of its own.
 */
async function visibilityRefusal(
  store: AssetStore,
  req: ApiRequest,
  key: string,
  verb: 'remove' | 'restore',
): Promise<ApiResponse<never> | null> {
  const meta = await store.getMeta(key)
  if (isAdmin(req.user.groups)) {
    return meta ? null : { ok: false, status: 404, error: 'File not found' }
  }
  if (!meta?.uploadedBy || meta.uploadedBy !== req.user.userId) {
    return { ok: false, status: 403, error: `You can only ${verb} files you uploaded` }
  }
  return null
}

/**
 * Remove a file from the library: write its hidden marker and leave its meta, originals and
 * public objects alone, so every URL and every transform, stored or not yet computed, keeps
 * working for content on any branch and in any build. `visibilityRefusal` says who may.
 *
 * The marker is create-only, so a second remove finds it and changes nothing. Remove, restore
 * and a re-upload's un-hide touch only the marker, and nothing but the library listing reads it:
 * the worst interleaving of two of them lists or omits one file until the next action.
 */
const hideAssetHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: AssetKeyBody,
): Promise<AssetVisibilityResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  const refusal = await visibilityRefusal(ctx.assetStore, req, body.key, 'remove')
  if (refusal) return refusal

  await ctx.assetStore.hideAsset(body.key, {
    hiddenAt: new Date().toISOString(),
    hiddenBy: req.user.userId,
  })
  return { ok: true, status: 200, data: { hidden: true } }
}

/** Put a removed file back in the library by deleting its hidden marker; see `hideAssetHandler`. */
const restoreAssetHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: AssetKeyBody,
): Promise<AssetVisibilityResponse> => {
  if (!ctx.assetStore) return { ok: false, status: 501, error: 'Asset store not configured' }

  const refusal = await visibilityRefusal(ctx.assetStore, req, body.key, 'restore')
  if (refusal) return refusal

  await ctx.assetStore.unhideAsset(body.key)
  return { ok: true, status: 200, data: { hidden: false } }
}

/**
 * The largest body this route returns inline. The CMS Lambda's Function URL buffers its response
 * and caps it at 6 MiB after base64 encoding, which inflates by 4/3, so 4 MiB leaves headroom.
 * Same bound and reasoning as the transform Lambda's `INLINE_BODY_LIMIT_BYTES`.
 */
const INLINE_BODY_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * A 302 to a presigned store URL, cacheable by this browser alone for as long as the store says
 * the URL stays reusable: the redirect then outlives a sign-out by at most that long, which is
 * accepted because the target is a public-prefix object under an unguessable key.
 */
function presignedRedirect({ url, maxAgeSeconds }: PresignedRead): CanopyBinaryResponse {
  return {
    kind: 'binary',
    status: 302,
    body: new Uint8Array(),
    headers: {
      location: url,
      cacheControl: maxAgeSeconds > 0 ? `private, max-age=${maxAgeSeconds}` : 'no-store',
    },
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
    const presigned = await assetStore.presignPublicObjectRead(canonicalKey)
    if (presigned) return presignedRedirect(presigned)
  }

  return {
    kind: 'binary',
    status: 200,
    body: transformed.data,
    headers: { contentType: transformed.contentType, cacheControl: TRANSFORM_CACHE_CONTROL },
  }
}

/**
 * For a streamed object stored without a Cache-Control of its own. Every key under the public
 * prefix is content-addressed, so its bytes never change; `private` because this route is
 * authenticated.
 */
const STREAMED_OBJECT_CACHE_CONTROL = 'private, max-age=31536000, immutable'

/** A redirect to, or the bytes of, the public object stored at `key`; `null` when there is none. */
async function serveStoredObject(
  assetStore: AssetStore,
  key: string,
): Promise<CanopyBinaryResponse | null> {
  if (assetStore.presignPublicObjectRead) {
    const presigned = await assetStore.presignPublicObjectRead(key)
    return presigned ? presignedRedirect(presigned) : null
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
      cacheControl: object.cacheControl ?? STREAMED_OBJECT_CACHE_CONTROL,
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
  readOnly: true,
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
  clientTimeout: 'long',
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

const hideAsset = defineEndpoint({
  namespace: 'assets',
  name: 'hide',
  method: 'POST',
  path: '/assets/hide',
  body: assetKeyBodySchema,
  bodyType: 'AssetKeyBody',
  responseType: 'AssetVisibilityResponse',
  response: {} as AssetVisibilityResponse,
  defaultMockData: { hidden: true },
  handler: hideAssetHandler,
})

const restoreAsset = defineEndpoint({
  namespace: 'assets',
  name: 'restore',
  method: 'POST',
  path: '/assets/restore',
  body: assetKeyBodySchema,
  bodyType: 'AssetKeyBody',
  responseType: 'AssetVisibilityResponse',
  response: {} as AssetVisibilityResponse,
  defaultMockData: { hidden: false },
  handler: restoreAssetHandler,
})

/**
 * DELETE /assets answers 410 instead of falling through to `DELETE /:branch` as a branch named
 * "assets". Hand-built like `assetRawRoute`, so the client generator emits no method for it.
 */
const deleteAssetGone: RouteDefinition = {
  method: 'DELETE',
  pattern: ['assets'],
  handler: async (): Promise<ApiResponse<never>> => ({
    ok: false,
    status: 410,
    error: 'DELETE /assets is gone: remove a file from the library with POST /assets/hide',
  }),
}

/**
 * Exported routes for router registration and client codegen.
 */
export const ASSET_ROUTES = {
  presign: presignAsset,
  finalize: finalizeAsset,
  uploadProxied,
  list: listAssets,
  hide: hideAsset,
  restore: restoreAsset,
  deleteGone: deleteAssetGone,
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
