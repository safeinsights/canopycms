/**
 * Prod on-demand image transform Lambda. Invoked by CloudFront's origin-group
 * failover on the `/assets/t/*` behavior (see `AssetSupport.assetBehaviors()`
 * in `../../src/constructs/asset-support.ts`) whenever the primary S3 origin
 * misses (403/404 - the canonical transform output doesn't exist yet).
 *
 * Reuses the SAME transform engine as the dev-mode `/assets/t/*` emulation
 * (`packages/canopycms/src/api/assets.ts`'s `serveLazyTransform`) via
 * `canopycms/server`'s `parseTransformPath`/`formatDirectives`/`applyTransform`
 * re-exports - this file must never reimplement directive parsing or the
 * sharp pipeline, only the S3/Lambda-specific plumbing around them.
 *
 * Flow, mirroring `serveLazyTransform` (see its doc comment for the full
 * rationale) with prod-specific handling for the Function URL's response
 * size cap:
 *   1. Parse `event.rawPath` (`/assets/t/{directives}/{hash32}/{slug}.{ext}`).
 *   2. Read `asset-meta/{hash32}.json` - 404 if absent, 400 if not `raster`
 *      (svg/pdf are served statically via `/assets/*`, never reach here).
 *   3. Read the original: direct `GetObject` by the meta-recorded extension
 *      first (the common case - one round trip), falling back to a
 *      `ListObjectsV2` prefix scan only on a miss.
 *   4. `applyTransform` - a typed rejection (undecodable input, encoder
 *      failure, oversized output) becomes a 422 JSON response.
 *   5. Write the output to S3 under the CANONICAL key
 *      (`assets/t/{formatDirectives(...)}/{hash32}/{slug}.{ext}`) FIRST, so
 *      the object exists before CloudFront's next request for it - even if
 *      this response never reaches the viewer.
 *   6. Return the bytes inline (base64, Function URL payload v2) when small
 *      enough to fit the Function URL's ~6 MiB buffered-response cap;
 *      otherwise 302 back to the request's own path with
 *      `Cache-Control: no-store` (CloudFront re-fetches from S3, now a hit -
 *      the `no-store` is required so the REDIRECT itself is never cached,
 *      which is the "cached-redirect trap" documented in the design record
 *      at .claude/future-tasks/assets-media-system.md).
 *
 * Note: URLs `canopycms` itself generates always carry canonically-ordered
 * directives (`assets/asset-url.ts`'s `assetUrl()` formats through the same
 * `formatDirectives`), so `rawPath` and the canonical key are the same
 * string in every URL this system produces. A hand-crafted request with a
 * non-canonical directive order would redirect back to a path that differs
 * from the just-written canonical key; CloudFront would miss again and this
 * Lambda would simply redo the (idempotent) transform on the next hit -
 * correct, just not optimally cached for that one non-canonical path.
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

import {
  applyTransform,
  ASSET_PREFIXES,
  formatDirectives,
  parseTransformPath,
  type AssetMeta,
} from 'canopycms/server'
import { getErrorMessage } from 'canopycms/utils/error'

const TRANSFORM_URL_PREFIX = `/${ASSET_PREFIXES.transform}/`
const TRANSFORM_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Function URLs buffer the response and base64-encode it for payload v2;
 * AWS documents a ~6 MiB cap on that buffered response. Base64 inflates
 * bytes by ~4/3, so 4.5 MiB of raw output stays comfortably under the cap
 * after encoding (4.5 MiB * 4/3 = 6 MiB).
 */
const INLINE_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

// Read once at cold start - a missing bucket name is a deploy-time
// misconfiguration, not a per-request condition, so failing the whole
// execution environment's INIT phase (visible in CloudWatch) is preferable
// to silently 500-ing every invocation.
const BUCKET = requireEnv('ASSET_BUCKET')

const s3 = new S3Client({})

/** Shape of the fields an AWS SDK v3 service exception carries - mirrors packages/canopycms/src/assets/store-s3.ts's own narrowing, duplicated here since this file ships as a standalone Lambda bundle. */
interface AwsServiceErrorShape {
  name?: string
  $metadata?: { httpStatusCode?: number }
}

function isNoSuchKey(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const shaped = err as Error & AwsServiceErrorShape
  return shaped.name === 'NoSuchKey' || shaped.$metadata?.httpStatusCode === 404
}

async function getObjectBytes(key: string): Promise<Uint8Array | null> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const bytes = await result.Body?.transformToByteArray()
    return bytes ?? null
  } catch (err: unknown) {
    if (isNoSuchKey(err)) return null
    throw err
  }
}

async function readMeta(hash32: string): Promise<AssetMeta | null> {
  const bytes = await getObjectBytes(`${ASSET_PREFIXES.meta}/${hash32}.json`)
  if (!bytes) return null
  return JSON.parse(Buffer.from(bytes).toString('utf-8')) as AssetMeta
}

/**
 * Read the original for `hash32`. Tries the direct key built from the
 * meta-recorded extension first (one round trip in the common case), and
 * only falls back to a `ListObjectsV2` prefix scan if that misses (defense
 * against the original's real extension having drifted from `meta.ext`).
 */
async function readOriginal(
  hash32: string,
  metaExt: string,
): Promise<{ data: Uint8Array; ext: string } | null> {
  const directKey = `${ASSET_PREFIXES.originals}/${hash32}.${metaExt}`
  const direct = await getObjectBytes(directKey)
  if (direct) {
    return { data: direct, ext: metaExt }
  }

  const prefix = `${ASSET_PREFIXES.originals}/${hash32}.`
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1 }),
  )
  const foundKey = listed.Contents?.[0]?.Key
  if (!foundKey) return null

  const bytes = await getObjectBytes(foundKey)
  if (!bytes) return null
  return { data: bytes, ext: foundKey.slice(prefix.length) }
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

const errorResponse = (statusCode: number, error: string): APIGatewayProxyStructuredResultV2 =>
  jsonResponse(statusCode, { error })

function inlineImageResponse(
  data: Uint8Array,
  contentType: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    headers: {
      'content-type': contentType,
      'cache-control': TRANSFORM_CACHE_CONTROL,
    },
    isBase64Encoded: true,
    body: Buffer.from(data).toString('base64'),
  }
}

function redirectNoStore(location: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 302,
    headers: {
      location,
      'cache-control': 'no-store',
    },
    body: '',
  }
}

async function handleTransformRequest(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawPath = event.rawPath ?? ''
  if (!rawPath.startsWith(TRANSFORM_URL_PREFIX)) {
    return errorResponse(400, `Expected a path under ${TRANSFORM_URL_PREFIX}`)
  }

  const segments = rawPath.slice(TRANSFORM_URL_PREFIX.length).split('/')
  const parsed = parseTransformPath(segments)
  if (!parsed.ok) {
    return errorResponse(400, parsed.error)
  }

  const meta = await readMeta(parsed.hash32)
  if (!meta) {
    return errorResponse(404, 'Not found')
  }
  if (meta.kind !== 'raster') {
    return errorResponse(400, 'Not a raster asset - svg/pdf are served statically')
  }

  // When the URL omits an explicit `f=` format, the transform preserves the
  // source format, so the URL's `{ext}` must match the source's real ext
  // exactly - the parser alone can't check this (it doesn't know the source
  // format until this meta lookup). Mirrors serveLazyTransform's dev-mode check.
  const requestedFormat = parsed.directives.identity ? undefined : parsed.directives.format
  if (requestedFormat === undefined && parsed.ext !== meta.ext) {
    return errorResponse(400, 'Extension does not match the source format')
  }

  const original = await readOriginal(parsed.hash32, meta.ext)
  if (!original) {
    return errorResponse(404, 'Not found')
  }

  const transformed = await applyTransform(
    { data: original.data, ext: original.ext },
    parsed.directives,
  )
  if (!transformed.ok) {
    return errorResponse(422, transformed.error)
  }

  const canonicalKey = `${ASSET_PREFIXES.transform}/${formatDirectives(parsed.directives)}/${parsed.hash32}/${parsed.slug}.${parsed.ext}`
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: canonicalKey,
      Body: transformed.data,
      ContentType: transformed.contentType,
      CacheControl: TRANSFORM_CACHE_CONTROL,
    }),
  )

  if (transformed.data.byteLength <= INLINE_BODY_LIMIT_BYTES) {
    return inlineImageResponse(transformed.data, transformed.contentType)
  }

  return redirectNoStore(rawPath)
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    return await handleTransformRequest(event)
  } catch (err: unknown) {
    // Terse, no stack trace - the client-facing body is not the place for
    // internals; the full error still reaches CloudWatch via console.error.
    console.error('asset-transform: unexpected error:', getErrorMessage(err))
    return errorResponse(500, 'Internal error')
  }
}
