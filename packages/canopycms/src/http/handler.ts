import type { CanopyRequest, CanopyResponse } from './types'
import { jsonResponse } from './types'
import { createCanopyRouter } from './router'
import type { ApiContext, ApiResponse } from '../api/types'
import type { AuthPlugin } from '../auth/plugin'
import { createCanopyServices, type CanopyServices } from '../services'
import type { CanopyConfig } from '../config'
import type { BranchContext } from '../types'
import { loadBranchContext, BranchWorkspaceManager } from '../branch-workspace'
import { authResultToCanopyUser } from '../user'
import { loadInternalGroups, RESERVED_GROUPS } from '../authorization'
import { clientOperatingStrategy } from '../operating-mode'

let warnedNoAdmins = false

/**
 * Options for creating a Canopy request handler.
 * This is framework-agnostic - adapters convert their framework's
 * request/response types to/from CanopyRequest/CanopyResponse.
 */
export interface CanopyHandlerOptions {
  services?: CanopyServices
  config?: CanopyConfig
  assetStore?: ApiContext['assetStore']
  getBranchContext?: (branch: string) => Promise<BranchContext | null>
  authPlugin: AuthPlugin
}

/**
 * Build API context from options.
 */
const buildContext = async (options: CanopyHandlerOptions): Promise<ApiContext> => {
  const services =
    options.services ?? (options.config ? await createCanopyServices(options.config) : undefined)
  if (!services) {
    throw new Error('CanopyCMS: config or services is required')
  }
  const operatingMode = services.config.mode
  const baseBranch = services.config.defaultBaseBranch ?? 'main'
  const settingsBranch = services.config.settingsBranch ?? 'canopycms-settings'

  const getBranchContext =
    options.getBranchContext ??
    (async (branch: string, opts?: { loadSchema?: boolean }): Promise<BranchContext | null> => {
      // Try to load existing branch
      const existing = await loadBranchContext({
        branchName: branch,
        mode: operatingMode,
      })
      if (existing) {
        // Optionally load per-branch schema
        if (opts?.loadSchema) {
          const contentRootName = services.config.contentRoot || 'content'
          const cached = await services.branchSchemaCache.getSchema(
            existing.branchRoot,
            services.entrySchemaRegistry,
            contentRootName,
          )
          existing.flatSchema = cached.flatSchema
        }
        return existing
      }

      // In modes that support branching, auto-create system branches if they don't exist
      const shouldAutoCreate =
        clientOperatingStrategy(operatingMode).supportsBranching() &&
        (branch === baseBranch || branch === settingsBranch)

      if (shouldAutoCreate) {
        const manager = new BranchWorkspaceManager(services.config)
        const context = await manager.openOrCreateBranch({
          branchName: branch,
          mode: operatingMode,
          createdBy: 'canopycms-system',
        })

        // Optionally load per-branch schema for auto-created branches
        if (opts?.loadSchema && context) {
          const contentRootName = services.config.contentRoot || 'content'
          const cached = await services.branchSchemaCache.getSchema(
            context.branchRoot,
            services.entrySchemaRegistry,
            contentRootName,
          )
          context.flatSchema = cached.flatSchema
        }

        return context
      }

      return null
    })

  return {
    services,
    assetStore: options.assetStore,
    getBranchContext,
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
  pathSegments: string[],
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

  return async (
    req: CanopyRequest,
    pathSegments: string[],
  ): Promise<CanopyResponse<ApiResponse>> => {
    // Route matching (fast, do first before async work)
    const match = router.match(req.method, pathSegments)
    if (!match) {
      return jsonResponse({ ok: false, status: 404, error: 'Not found' }, 404)
    }

    // Get cached context
    const apiCtx = await getContext()

    // Authenticate and convert to CanopyUser
    const authResult = await options.authPlugin.authenticate(req)

    // Load internal groups from main branch and merge with user groups
    const baseBranch = apiCtx.services.config.defaultBaseBranch ?? 'main'
    const mainBranchContext = await apiCtx.getBranchContext(baseBranch)
    const operatingMode = apiCtx.services.config.mode
    const internalGroups = mainBranchContext
      ? await loadInternalGroups(
          mainBranchContext.branchRoot,
          operatingMode,
          apiCtx.services.bootstrapAdminIds,
        ).catch((err: unknown) => {
          console.warn('CanopyCMS: Failed to load internal groups from main branch:', err)
          return []
        })
      : []

    if (!warnedNoAdmins && Array.isArray(internalGroups)) {
      const adminsGroup = internalGroups.find((g) => g.id === RESERVED_GROUPS.ADMINS)
      if (!adminsGroup || adminsGroup.members.length === 0) {
        console.warn(
          'CanopyCMS: No admin users configured. Set CANOPY_BOOTSTRAP_ADMIN_IDS or add members to the Admins group.',
        )
      }
      warnedNoAdmins = true
    }

    const user = authResultToCanopyUser(
      authResult,
      apiCtx.services.bootstrapAdminIds,
      internalGroups,
    )

    // API routes require authentication - reject anonymous users
    if (user.type === 'anonymous') {
      return jsonResponse(
        { ok: false, status: 401, error: authResult.error ?? 'Unauthorized' },
        401,
      )
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
    const branch =
      (mergedParams as Record<string, string>)?.branch ??
      (body as Record<string, unknown> | undefined)?.branch
    const apiReq = { user, body, branch, query: queryParams }

    // Validate params and body using the route's validation function (if available)
    if (match.validate) {
      const validationResult = match.validate({ params: mergedParams, body })
      if (!validationResult.ok) {
        return jsonResponse({ ok: false, status: 400, error: validationResult.error }, 400)
      }

      // Call handler with validated params/body based on what's defined
      const handlerArgs: unknown[] = [apiCtx, apiReq]
      if (validationResult.params !== undefined) {
        handlerArgs.push(validationResult.params)
      }
      if (validationResult.body !== undefined) {
        handlerArgs.push(validationResult.body)
      }

      const result = await match.handler(...handlerArgs)
      return jsonResponse(result, result.status)
    } else {
      // Should not happen - all routes should use defineEndpoint now
      // This is here for safety in case any route doesn't have validation
      const result = await match.handler(
        apiCtx as unknown,
        apiReq as unknown,
        mergedParams as unknown,
      )
      return jsonResponse(result, result.status)
    }
  }
}

/**
 * Create a handler with pre-built services from config.
 */
export async function createCanopyRequestHandlerFromConfig(
  options: { config: CanopyConfig } & Omit<CanopyHandlerOptions, 'services' | 'config'>,
): Promise<CanopyRequestHandler> {
  return createCanopyRequestHandler({
    ...options,
    services: await createCanopyServices(options.config),
  })
}
