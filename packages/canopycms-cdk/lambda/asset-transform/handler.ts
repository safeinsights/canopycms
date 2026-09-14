/**
 * Prod on-demand image transform Lambda. Invoked by CloudFront's origin-group
 * failover on the `/assets/t/*` behavior (see `AssetSupport.assetBehaviors()`
 * in `../../src/constructs/asset-support.ts`) whenever the primary S3 origin
 * misses (403/404 - the canonical transform output doesn't exist yet).
 *
 * Reuses the SAME transform engine as the dev-mode `/assets/t/*` emulation
 * (`packages/canopycms/src/api/assets.ts`'s `serveLazyTransform`) via
 * `canopycms/server`'s `parseTransformPath`/`formatDirectives`/`applyTransform`
 * re-exports - this file must NEVER reimplement directive parsing or the sharp
 * pipeline, only the S3/Lambda-specific plumbing around them. See
 * `serveLazyTransform` for the shared flow's rationale.
 *
 * Two orderings here are prod-specific and load-bearing:
 *
 * - The transformed bytes are written to S3 under the CANONICAL key BEFORE the
 *   response is built, so the object exists for CloudFront's next request even
 *   if this response never reaches the viewer.
 * - An output too large for the Function URL's ~6 MiB buffered-response cap is
 *   answered with a 302 carrying `Cache-Control: no-store`, so the REDIRECT
 *   itself is never cached at the CloudFront layer - the "cached-redirect trap"
 *   in the design record (.claude/future-tasks/resolved/assets-media-system.md). The
 *   other half of that trap is closed by the custom minTtl-0 cache policy
 *   `AssetSupport` attaches to this behavior instead of the managed
 *   CACHING_OPTIMIZED, whose 1s min TTL would cache the `no-store` anyway.
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
 * Function URLs buffer the response and base64-encode it for payload v2, with a
 * documented ~6 MiB cap on that buffered response. Base64 inflates bytes by
 * exactly 4/3, so 4 MiB of raw output becomes ~5.33 MiB encoded - real headroom
 * under the cap for the framing Lambda's own invoke result adds. A threshold
 * whose 4/3 lands exactly ON 6 MiB has zero headroom and 502s the first request
 * for an output near the cap.
 */
const INLINE_BODY_LIMIT_BYTES = 4 * 1024 * 1024

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

  // The slug is decorative in the URL but LOAD-BEARING in the S3 key, so it
  // has to be pinned to the asset's real slug. `[a-z0-9-]+` is all the parser
  // can enforce, and every distinct string that passes it aliases the same
  // image into a brand-new cache key: a new CloudFront miss, a new sharp
  // invocation, and a new stored object, without limit. Canopy's own URLs are
  // always built from `meta.slug` (assets/asset-url.ts), so nothing legitimate
  // reaches here with anything else.
  if (parsed.slug !== meta.slug) {
    return errorResponse(404, 'Not found')
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
    // Pass the real status through rather than flattening every rejection to
    // 422 - `applyTransform` already distinguishes client-input errors (400
    // unsupported format, 413 oversized output) from a genuine decode
    // failure (422), and collapsing them all to 422 mislabels the first two
    // as "unprocessable" when they're really "bad request"/"too large".
    return errorResponse(transformed.status, transformed.error)
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

  // Redirect to the CANONICAL key just written above, NOT `rawPath`. For a
  // non-canonically-ordered directive request the two differ, and the canonical
  // key is what actually exists in S3 - redirecting back to `rawPath` would have
  // CloudFront re-miss that path forever, re-invoking this Lambda on every hit
  // instead of ever landing a cache hit. URLs canopycms itself generates are
  // always canonically ordered (`assets/asset-url.ts`'s `assetUrl()` formats
  // through the same `formatDirectives`), so only a hand-crafted request
  // reaches this case at all.
  return redirectNoStore(`/${canonicalKey}`)
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
