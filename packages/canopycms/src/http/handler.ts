import type { CanopyBinaryResponse, CanopyRequest, CanopyResponse } from './types'
import { jsonResponse, isCanopyBinaryResponse } from './types'
import { createCanopyRouter } from './router'
import type { ApiContext, ApiResponse } from '../api/types'
import { assertAuthPluginAllowedForMode, type AuthPlugin } from '../auth/plugin'
import { createCanopyServices, type CanopyServices } from '../services'
import type { CanopyConfig } from '../config'
import type { BranchContext } from '../types'
import { loadBranchContext, BranchWorkspaceManager } from '../branch-workspace'
import { authResultToCanopyUser } from '../user'
import { loadInternalGroups, RESERVED_GROUPS } from '../authorization'
import { clientOperatingStrategy } from '../operating-mode'
import { getErrorMessage, redactCredentials, sanitizeErrorMessage } from '../utils/error'

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

      // In modes that support branching, auto-create system branches if they don't exist.
      // Read from services.config per-request (not a captured variable) so that
      // refreshActiveBranch() updates are reflected immediately.
      const baseBranch = services.config.defaultBaseBranch ?? 'main'
      const activeBranch = services.config.defaultActiveBranch ?? baseBranch
      const shouldAutoCreate =
        clientOperatingStrategy(operatingMode).supportsBranching() &&
        (branch === baseBranch || branch === activeBranch || branch === settingsBranch)

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
 * Widened to include `CanopyBinaryResponse` so routes that stream bytes
 * (e.g. asset serving) can flow through this handler untouched alongside
 * ordinary JSON routes - see `isCanopyBinaryResponse` usage below.
 */
export type CanopyRequestHandler = (
  req: CanopyRequest,
  pathSegments: string[],
) => Promise<CanopyResponse<ApiResponse> | CanopyBinaryResponse>

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
  // Fail closed (SEC-C1): a dev/insecure auth plugin must never serve prod traffic.
  // Throws at handler creation time so misconfigured deployments fail at startup.
  const mode = options.services?.config.mode ?? options.config?.mode
  assertAuthPluginAllowedForMode(options.authPlugin, mode)

  const router = createCanopyRouter()

  // Build context once (memoized) and reuse across requests in the same warm
  // container/process. On rejection (e.g. transient cold-start / EFS not yet
  // mounted), the cache is cleared (API-H3) so the NEXT request retries
  // buildContext() instead of replaying the same rejection forever.
  let apiCtxPromise: Promise<ApiContext> | null = null
  const getContext = () => {
    if (!apiCtxPromise) {
      apiCtxPromise = buildContext(options).catch((err: unknown) => {
        apiCtxPromise = null
        throw err
      })
    }
    return apiCtxPromise
  }

  // Core request-handling logic, wrapped below by a top-level try/catch (API-C1).
  // getContext()/refreshActiveBranch()/authenticate()/match.handler() are NOT
  // individually try/catched here, and some handlers deliberately re-throw
  // unrecognized errors (e.g. api/content.ts, api/entries.ts) — without an outer
  // boundary, an unhandled throw would escape the framework adapter as a generic
  // 500 that breaks the uniform { ok, status, error } contract the editor depends on.
  const handleRequest = async (
    req: CanopyRequest,
    pathSegments: string[],
  ): Promise<CanopyResponse<ApiResponse> | CanopyBinaryResponse> => {
    // Route matching (fast, do first before async work)
    const match = router.match(req.method, pathSegments)
    if (!match) {
      return jsonResponse({ ok: false, status: 404, error: 'Not found' }, 404)
    }

    // Get cached context
    const apiCtx = await getContext()

    // In dev mode, re-check if the developer switched git branches
    await apiCtx.services.refreshActiveBranch()

    // Authenticate and convert to CanopyUser
    const authResult = await options.authPlugin.authenticate(req)

    // API routes require authentication. Reject anonymous callers BEFORE any
    // workspace provisioning below, so they can neither trigger expensive git
    // operations nor read provisioning error details.
    if (!authResult.success || !authResult.user) {
      return jsonResponse(
        { ok: false, status: 401, error: authResult.error ?? 'Unauthorized' },
        401,
      )
    }

    // Load internal groups from the base branch and merge with user groups.
    // This getBranchContext call also auto-creates the base/active workspace
    // on first request — if that provisioning fails, every endpoint would
    // otherwise return confusing empty results, so fail loudly instead.
    const baseBranch = apiCtx.services.config.defaultBaseBranch ?? 'main'
    let mainBranchContext: BranchContext | null
    try {
      mainBranchContext = await apiCtx.getBranchContext(baseBranch)
    } catch (err) {
      const message = getErrorMessage(err)
      // Full path detail to server logs; sanitized detail to the
      // (authenticated) client. Credentials (git errors can embed them) are
      // redacted even from server logs.
      console.error(
        `CanopyCMS: Failed to provision workspace for base branch '${baseBranch}': ${redactCredentials(message)}`,
      )
      return jsonResponse(
        {
          ok: false,
          status: 503,
          error: `Branch workspace provisioning failed for '${baseBranch}': ${sanitizeErrorMessage(message)}`,
        },
        503,
      )
    }
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
      const hasAdmins =
        (adminsGroup && adminsGroup.members.length > 0) ||
        apiCtx.services.bootstrapAdminIds.size > 0
      if (!hasAdmins) {
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

    // Parse body for non-GET requests. Multipart routes opt out (bodyFormat)
    // so their handler can read the (single-use) body stream itself via
    // req.formData() - calling req.json() first would consume it.
    let body: unknown
    if (req.method !== 'GET' && match.bodyFormat !== 'multipart') {
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
    const apiReq = { user, body, branch, query: queryParams, rawRequest: req }

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
      // Binary routes (e.g. asset serving) carry their own status/headers and
      // must reach the adapter untouched - wrapping them in jsonResponse would
      // JSON-serialize raw bytes and lose contentType/contentDisposition/etc.
      if (isCanopyBinaryResponse(result)) return result
      return jsonResponse(result, result.status)
    } else {
      // Should not happen - all routes should use defineEndpoint now
      // This is here for safety in case any route doesn't have validation
      const result = await match.handler(
        apiCtx as unknown,
        apiReq as unknown,
        mergedParams as unknown,
      )
      if (isCanopyBinaryResponse(result)) return result
      return jsonResponse(result, result.status)
    }
  }

  return async (
    req: CanopyRequest,
    pathSegments: string[],
  ): Promise<CanopyResponse<ApiResponse> | CanopyBinaryResponse> => {
    try {
      return await handleRequest(req, pathSegments)
    } catch (err) {
      // Last-resort boundary (API-C1): see handleRequest's doc comment above.
      const message = getErrorMessage(err)
      console.error('CanopyCMS: Unhandled error in API request handler:', message)
      return jsonResponse({ ok: false, status: 500, error: sanitizeErrorMessage(message) }, 500)
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
