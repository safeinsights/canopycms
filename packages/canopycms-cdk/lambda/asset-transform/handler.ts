/**
 * The opt-in lazy transform Lambda (`AssetSupport`'s `lazyPublicTransforms`), behind the
 * `/assets/t/*` origin group's S3 miss. It computes and stores through `storeTransform`, the same
 * code the authenticated raw route and `materialize-assets` use, and adds only what is specific
 * to an anonymous Function URL:
 *
 * - A non-canonical spelling gets a cacheable 301 to the canonical path before any S3 call, so a
 *   new spelling costs a cached redirect, never a transform.
 * - An output over the Function URL's ~6 MiB buffered-response cap gets a `no-store` 302 to the
 *   key just written. `AssetSupport`'s minTtl-0 cache policy keeps CloudFront from caching it.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

import {
  ASSET_PREFIXES,
  canonicalizeTransformPath,
  createAssetStore,
  storeTransform,
  TRANSFORM_CACHE_CONTROL,
} from 'canopycms/server'
import { getErrorMessage } from 'canopycms/utils/error'

const TRANSFORM_URL_PREFIX = `/${ASSET_PREFIXES.transform}/`

/**
 * Base64 inflates by 4/3, so 4 MiB of output encodes to ~5.33 MiB, leaving headroom under the
 * ~6 MiB cap for the invoke result's own framing.
 */
const INLINE_BODY_LIMIT_BYTES = 4 * 1024 * 1024

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function createStore(): NonNullable<ReturnType<typeof createAssetStore>> {
  const created = createAssetStore({
    adapter: 's3',
    bucket: requireEnv('ASSET_BUCKET'),
    region: requireEnv('AWS_REGION'),
  })
  if (!created) {
    throw new Error('createAssetStore returned no store for the s3 adapter')
  }
  return created
}

// Built at cold start: a missing variable is a deploy fault, and failing INIT shows in CloudWatch.
const store = createStore()

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

const errorResponse = (statusCode: number, error: string): APIGatewayProxyStructuredResultV2 =>
  jsonResponse(statusCode, { error })

async function handleTransformRequest(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const rawPath = event.rawPath ?? ''
  if (!rawPath.startsWith(TRANSFORM_URL_PREFIX)) {
    return errorResponse(400, `Expected a path under ${TRANSFORM_URL_PREFIX}`)
  }

  const segments = rawPath.slice(TRANSFORM_URL_PREFIX.length).split('/')
  const parsed = canonicalizeTransformPath(segments, 'allowlist')
  if (!parsed.ok) {
    return errorResponse(400, parsed.error)
  }
  // Safe to cache for a year: the canonical path canonicalizes to itself, so it never 301s again.
  if (!parsed.isCanonical) {
    return {
      statusCode: 301,
      headers: {
        location: `${TRANSFORM_URL_PREFIX}${parsed.canonicalPath}`,
        'cache-control': TRANSFORM_CACHE_CONTROL,
      },
      body: '',
    }
  }

  const canonicalKey = `${ASSET_PREFIXES.transform}/${parsed.canonicalPath}`
  const result = await storeTransform(store, parsed, canonicalKey)
  if (!result.ok) {
    // A 404's `error` names the hash and the real slug; an anonymous caller gets neither.
    return errorResponse(result.status, result.status === 404 ? 'Not found' : result.error)
  }

  if (result.data.byteLength > INLINE_BODY_LIMIT_BYTES) {
    return {
      statusCode: 302,
      headers: { location: `/${canonicalKey}`, 'cache-control': 'no-store' },
      body: '',
    }
  }
  return {
    statusCode: 200,
    headers: { 'content-type': result.contentType, 'cache-control': TRANSFORM_CACHE_CONTROL },
    isBase64Encoded: true,
    body: Buffer.from(result.data).toString('base64'),
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    return await handleTransformRequest(event)
  } catch (err: unknown) {
    // The body stays terse; the message reaches CloudWatch.
    console.error('asset-transform: unexpected error:', getErrorMessage(err))
    return errorResponse(500, 'Internal error')
  }
}
