import { NextResponse } from 'next/server'

import {
  createCanopyRequestHandler,
  type CanopyHandlerOptions,
  type CanopyRequest,
  type CanopyResponse,
} from 'canopycms/http'

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
  }
}

/**
 * Convert a CanopyResponse to a NextResponse.
 */
function toNextResponse(response: CanopyResponse<unknown>): Response {
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
    const canopyReq = wrapNextRequest(req)
    const segments = await extractPathSegments(ctx)
    const response = await coreHandler(canopyReq, segments)
    return toNextResponse(response)
  }
}
