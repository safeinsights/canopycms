import { NextResponse } from 'next/server'

import {
  createCanopyRequestHandler,
  isCanopyBinaryResponse,
  type CanopyBinaryResponse,
  type CanopyHandlerOptions,
  type CanopyRequest,
  type CanopyResponse,
} from 'canopycms/http'
import { getErrorMessage, redactCredentials, sanitizeErrorMessage } from 'canopycms/utils/error'

/**
 * Options for creating a Canopy Next.js handler.
 * Same as core CanopyHandlerOptions - re-exported for convenience.
 */
export type CanopyNextOptions = CanopyHandlerOptions

/**
 * Wrap a standard Request (or NextRequest) to implement the CanopyRequest interface.
 * Only uses standard Request methods, so any Request subclass works.
 */
export function wrapNextRequest(req: Request): CanopyRequest {
  return {
    method: req.method,
    url: req.url,

    header(name: string): string | null {
      return req.headers.get(name)
    },

    async json(): Promise<unknown> {
      if (req.method === 'GET') return undefined
      try {
        return await req.json()
      } catch {
        return undefined
      }
    },

    async rawBody(): Promise<Uint8Array> {
      return new Uint8Array(await req.arrayBuffer())
    },

    async formData(): Promise<FormData> {
      return req.formData()
    },
  }
}

/**
 * Map a CanopyBinaryResponse's framework-agnostic header fields onto the
 * real HTTP header names, omitting any that weren't set.
 */
function toBinaryHeaders(headers: CanopyBinaryResponse['headers']): HeadersInit {
  const result: Record<string, string> = {}
  if (headers.contentType) result['Content-Type'] = headers.contentType
  if (headers.contentDisposition) result['Content-Disposition'] = headers.contentDisposition
  if (headers.cacheControl) result['Cache-Control'] = headers.cacheControl
  if (headers.etag) result['ETag'] = headers.etag
  return result
}

/**
 * Convert a CanopyResponse (or CanopyBinaryResponse) to a NextResponse.
 */
function toNextResponse(response: CanopyResponse<unknown> | CanopyBinaryResponse): Response {
  if (isCanopyBinaryResponse(response)) {
    // A Uint8Array can be backed by an arbitrary ArrayBufferLike (e.g. a
    // Node Buffer), which doesn't structurally satisfy the DOM lib's
    // BodyInit/ArrayBufferView (specifically ArrayBuffer-backed). Copying
    // through the typed-array constructor yields a plain ArrayBuffer-backed
    // view so this type-checks without an unsafe cast; ReadableStream
    // bodies pass through unchanged.
    const body = response.body instanceof Uint8Array ? new Uint8Array(response.body) : response.body
    return new NextResponse(body, {
      status: response.status,
      headers: toBinaryHeaders(response.headers),
    })
  }
  return NextResponse.json(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

/**
 * Extract path segments from Next.js catch-all route params.
 * Handles both Next.js 14 (direct object) and Next.js 15 (Promise) params.
 */
async function extractPathSegments(ctx?: {
  params?: Promise<{ canopycms?: string[] }> | { canopycms?: string[] }
}): Promise<string[]> {
  if (!ctx?.params) return []
  const resolvedParams = ctx.params instanceof Promise ? await ctx.params : ctx.params
  return (resolvedParams?.canopycms ?? []).filter(Boolean)
}

/**
 * Catch-all Next.js handler for a single API route (e.g., /api/canopycms/[...canopycms]).
 *
 * This is a thin adapter that:
 * 1. Converts NextRequest to CanopyRequest
 * 2. Extracts path segments from Next.js params
 * 3. Delegates to the core handler
 * 4. Converts CanopyResponse to NextResponse
 *
 * @example
 * ```ts
 * // app/api/canopycms/[...canopycms]/route.ts
 * import { createCanopyCatchAllHandler } from 'canopycms-next'
 * import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
 * import config from '../../../../canopycms.config'
 *
 * const handler = createCanopyCatchAllHandler({
 *   config: config.server,
 *   authPlugin: createClerkAuthPlugin({ useOrganizationsAsGroups: true }),
 * })
 *
 * export const GET = handler
 * export const POST = handler
 * export const PUT = handler
 * export const PATCH = handler
 * export const DELETE = handler
 * ```
 */
export const createCanopyCatchAllHandler = (options: CanopyNextOptions) => {
  const coreHandler = createCanopyRequestHandler(options)

  return async (
    req: Request,
    ctx?: {
      params?:
        | Promise<{ canopycms?: string[]; [key: string]: unknown }>
        | { canopycms?: string[]; [key: string]: unknown }
    },
  ): Promise<Response> => {
    try {
      const canopyReq = wrapNextRequest(req)
      const segments = await extractPathSegments(ctx)
      const response = await coreHandler(canopyReq, segments)
      return toNextResponse(response)
    } catch (err) {
      // Defense-in-depth (API-C1): coreHandler already guards itself with a
      // top-level try/catch, but this adapter also wraps request conversion
      // (wrapNextRequest/extractPathSegments/toNextResponse) so a failure there
      // can never escape as Next's generic unhandled-error 500, which would
      // break the uniform { ok, status, error } envelope the editor expects.
      const message = getErrorMessage(err)
      // Redacted before logging, not just before responding. The HTTP body was
      // already sanitized, but this line went to the server log verbatim -- and
      // a git failure message can embed a token-bearing clone URL, which is the
      // one thing that must not reach a log aggregator. Every failure surface
      // in the worker already redacts; this was the outlier.
      console.error(
        'CanopyCMS: Unhandled error in Next.js catch-all handler:',
        redactCredentials(message),
      )
      return toNextResponse({
        status: 500,
        body: { ok: false, status: 500, error: sanitizeErrorMessage(message) },
      })
    }
  }
}
