import type { CanopyRequest, CanopyResponse } from './types'
import { jsonResponse } from './types'
import { createCanopyRouter, type CanopyRouter } from './router'
import type { ApiContext, ApiResponse } from '../api/types'
import type { AuthPlugin } from '../auth/plugin'
import { createCanopyServices, getEffectiveGroups, type CanopyServices } from '../services'
import type { CanopyConfig } from '../config'
import type { BranchState } from '../types'
import { loadBranchState } from '../branch-workspace'
import type { AuthenticatedUser } from '../user'

/**
 * Options for creating a Canopy request handler.
 * This is framework-agnostic - adapters convert their framework's
 * request/response types to/from CanopyRequest/CanopyResponse.
 */
export interface CanopyHandlerOptions {
  services?: CanopyServices
  config?: CanopyConfig
  assetStore?: ApiContext['assetStore']
  getBranchState?: (branch: string) => Promise<BranchState | null>
  authPlugin: AuthPlugin
}

/**
 * Build API context from options.
 */
const buildContext = async (options: CanopyHandlerOptions): Promise<ApiContext> => {
  const services =
    options.services ?? (options.config ? createCanopyServices(options.config) : undefined)
  if (!services) {
    throw new Error('CanopyCMS: config or services is required')
  }
  const branchMode = services.config.mode ?? 'local-simple'
  const getBranchState =
    options.getBranchState ??
    (async (branch: string) =>
      (await loadBranchState({ branchName: branch, mode: branchMode })) ?? null)
  return {
    services,
    assetStore: options.assetStore,
    getBranchState,
    authPlugin: options.authPlugin,
  }
}

/**
 * Parse query parameters from URL.
 */
const parseQueryParams = (url: string): Record<string, string> => {
  try {
    const urlObj = new URL(url, 'http://localhost')
    return Object.fromEntries(urlObj.searchParams.entries())
  } catch {
    return {}
  }
}

/**
 * Core request handler result type.
 */
export type CanopyRequestHandler = (
  req: CanopyRequest,
  pathSegments: string[]
) => Promise<CanopyResponse<ApiResponse>>

/**
 * Create a framework-agnostic Canopy request handler.
 *
 * This is the core handler that processes all Canopy API requests.
 * Framework adapters (Next.js, Express, Hono, etc.) should:
 * 1. Convert their framework's request to CanopyRequest
 * 2. Extract path segments from the URL
 * 3. Call this handler
 * 4. Convert the CanopyResponse to their framework's response
 *
 * @example
 * ```ts
 * // In a framework adapter
 * const coreHandler = createCanopyRequestHandler({
 *   config: myConfig,
 *   authPlugin: myAuthPlugin,
 * })
 *
 * // Framework-specific handler
 * async function handleRequest(frameworkReq) {
 *   const canopyReq = convertToCanopyRequest(frameworkReq)
 *   const segments = extractPathSegments(frameworkReq)
 *   const response = await coreHandler(canopyReq, segments)
 *   return convertToFrameworkResponse(response)
 * }
 * ```
 */
export function createCanopyRequestHandler(options: CanopyHandlerOptions): CanopyRequestHandler {
  const router = createCanopyRouter()

  // Build context once at initialization, not per-request
  let apiCtxPromise: Promise<ApiContext> | null = null
  const getContext = () => {
    if (!apiCtxPromise) {
      apiCtxPromise = buildContext(options)
    }
    return apiCtxPromise
  }

  return async (req: CanopyRequest, pathSegments: string[]): Promise<CanopyResponse<ApiResponse>> => {
    // Route matching (fast, do first before async work)
    const match = router.match(req.method, pathSegments)
    if (!match) {
      return jsonResponse({ ok: false, status: 404, error: 'Not found' }, 404)
    }

    // Get cached context
    const apiCtx = await getContext()

    // Authenticate
    const authResult = await options.authPlugin.verifyToken(req)
    if (!authResult.valid || !authResult.user) {
      return jsonResponse(
        { ok: false, status: 401, error: authResult.error ?? 'Unauthorized' },
        401
      )
    }

    // Apply bootstrap admin groups and ensure user is an AuthenticatedUser
    const user: AuthenticatedUser = {
      ...authResult.user,
      type: 'authenticated',
      groups: getEffectiveGroups(
        authResult.user.userId,
        authResult.user.groups,
        apiCtx.services.bootstrapAdminIds
      ),
    }

    // Parse query params and merge with route params
    const queryParams = parseQueryParams(req.url)
    const mergedParams = { ...queryParams, ...match.params }

    // Parse body for non-GET requests
    let body: unknown
    if (req.method !== 'GET') {
      try {
        body = await req.json()
      } catch {
        body = undefined
      }
    }

    // Build API request
    const branch = (mergedParams as any)?.branch ?? (body as any)?.branch
    const apiReq = { user, body, branch }

    // Call the handler
    const result = await match.handler(apiCtx as any, apiReq as any, mergedParams as any)
    return jsonResponse(result, result.status)
  }
}

/**
 * Create a handler with pre-built services from config.
 */
export function createCanopyRequestHandlerFromConfig(
  options: { config: CanopyConfig } & Omit<CanopyHandlerOptions, 'services' | 'config'>
): CanopyRequestHandler {
  return createCanopyRequestHandler({
    ...options,
    services: createCanopyServices(options.config),
  })
}
