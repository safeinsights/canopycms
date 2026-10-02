import type { CanopyBinaryResponse, CanopyRequest, CanopyResponse } from './types'
import { jsonResponse, isCanopyBinaryResponse } from './types'
import { createCanopyRouter } from './router'
import type { ApiContext, ApiResponse } from '../api/types'
import { assertAuthPluginAllowedForMode, type AuthPlugin } from '../auth/plugin'
import { createCanopyServices, type CanopyServices } from '../services'
import type { CanopyConfig } from '../config'
import type { BranchContext } from '../types'
import { loadBranchContext, BranchWorkspaceManager } from '../branch-workspace'
import { BranchMetadataCorruptError } from '../branch-metadata'
import { resolveCanopyUser } from '../resolve-canopy-user'
import { authResultToCanopyUser } from '../user'
import { isAdmin } from '../authorization'
import { clientOperatingStrategy, operatingStrategy } from '../operating-mode'
import { getErrorMessage, redactCredentials, sanitizeErrorMessage } from '../utils/error'
// canopyLogError, not console.error: this is shared code and not guaranteed to
// stay out of the worker's runtime import closure, so new log lines here go
// through the indirection (utils/logger.ts).
import { canopyLogError } from '../utils/logger'

/** Framework-agnostic: adapters convert to and from CanopyRequest/Response. */
export interface CanopyHandlerOptions {
  services?: CanopyServices
  config?: CanopyConfig
  assetStore?: ApiContext['assetStore']
  getBranchContext?: (branch: string) => Promise<BranchContext | null>
  authPlugin: AuthPlugin
}

const buildContext = async (options: CanopyHandlerOptions): Promise<ApiContext> => {
  const services =
    options.services ?? (options.config ? await createCanopyServices(options.config) : undefined)
  if (!services) {
    throw new Error('CanopyCMS: config or services is required')
  }
  const operatingMode = services.config.mode
  // Derive from the strategy, which resolves deploymentName; a literal here
  // would not match a deployment-namespaced settings branch (say
  // canopycms-settings-acme), so getBranchContext could never auto-create it.
  const settingsBranch = operatingStrategy(operatingMode).getSettingsBranchName(services.config)

  const getBranchContext =
    options.getBranchContext ??
    (async (branch: string, opts?: { loadSchema?: boolean }): Promise<BranchContext | null> => {
      const existing = await loadBranchContext({
        branchName: branch,
        mode: operatingMode,
      })
      if (existing) {
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

      // Read from services.config per-request, not a captured variable, so a
      // refreshActiveBranch() update takes effect immediately.
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

const parseQueryParams = (url: string): Record<string, string> => {
  try {
    const urlObj = new URL(url, 'http://localhost')
    return Object.fromEntries(urlObj.searchParams.entries())
  } catch {
    return {}
  }
}

/**
 * Includes `CanopyBinaryResponse` so byte-streaming routes (asset serving) flow
 * through untouched alongside JSON ones — see `isCanopyBinaryResponse` below.
 */
export type CanopyRequestHandler = (
  req: CanopyRequest,
  pathSegments: string[],
) => Promise<CanopyResponse<ApiResponse> | CanopyBinaryResponse>

/**
 * The core handler behind every Canopy API request. A framework adapter
 * (Next.js, Express, Hono) converts its request to a CanopyRequest, extracts
 * the path segments, calls this, and converts the CanopyResponse back.
 */
export function createCanopyRequestHandler(options: CanopyHandlerOptions): CanopyRequestHandler {
  // Fail closed (SEC-C1): a dev/insecure auth plugin must never serve prod traffic.
  // Throws at handler creation time so misconfigured deployments fail at startup.
  const mode = options.services?.config.mode ?? options.config?.mode
  assertAuthPluginAllowedForMode(options.authPlugin, mode)

  const router = createCanopyRouter()

  // Built once and reused across requests in the same warm container. On
  // rejection (transient cold start, EFS not yet mounted) the cache is cleared
  // (API-H3) so the NEXT request retries instead of replaying the rejection.
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

  // Wrapped below by a top-level try/catch (API-C1). Nothing in here is
  // individually try/catched, and some handlers deliberately re-throw
  // unrecognized errors, so without that outer boundary an unhandled throw
  // would escape the adapter as a generic 500 and break the uniform
  // { ok, status, error } contract the editor depends on.
  const handleRequest = async (
    req: CanopyRequest,
    pathSegments: string[],
  ): Promise<CanopyResponse<ApiResponse> | CanopyBinaryResponse> => {
    const match = router.match(req.method, pathSegments)
    if (!match) {
      return jsonResponse({ ok: false, status: 404, error: 'Not found' }, 404)
    }

    const apiCtx = await getContext()

    // In dev mode, re-check if the developer switched git branches
    await apiCtx.services.refreshActiveBranch()

    const authResult = await options.authPlugin.authenticate(req)

    // API routes require authentication. Anonymous callers are rejected BEFORE
    // any workspace provisioning below, so they can neither trigger expensive
    // git operations nor read provisioning error details.
    if (!authResult.success || !authResult.user) {
      return jsonResponse(
        { ok: false, status: 401, error: authResult.error ?? 'Unauthorized' },
        401,
      )
    }

    // Provision the base/active branch workspace on first request, so the many
    // endpoints that assume it exists (registry reads and the like) don't return
    // confusing empty results on a cold start. A real provisioning error fails
    // loudly here rather than surprising a later handler.
    const baseBranch = apiCtx.services.config.defaultBaseBranch ?? 'main'
    try {
      await apiCtx.getBranchContext(baseBranch)
    } catch (err) {
      const message = getErrorMessage(err)
      if (err instanceof BranchMetadataCorruptError) {
        // Corrupt BASE branch metadata must not take down every endpoint,
        // since /admin is how it gets fixed. Keep routing instead: internal
        // groups come from the settings workspace below, independent of this
        // branch's health.
        console.error(
          `CanopyCMS: Base branch '${baseBranch}' has corrupt metadata; serving without base-branch provisioning until repaired: ${redactCredentials(message)}`,
        )
      } else {
        // Full path detail to server logs, sanitized detail to the
        // (authenticated) client. Credentials, which git errors can embed, are
        // redacted even from the server logs.
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
    }

    // Internal groups are the single source of truth for group-based privilege
    // and MUST come from the settings workspace (the pattern in
    // authorization/content.ts's createContentAccessChecker), never from a
    // content branch clone, which nothing writes groups.json into. A failure
    // throws, mapped to a 503 below, rather than degrading to an empty group
    // list: "no groups" reads as "no privileges", so a silent fallback would be
    // a silent authorization change.
    let user
    try {
      user = await resolveCanopyUser(authResult, {
        getSettingsBranchRoot: apiCtx.services.getSettingsBranchRoot,
        mode: apiCtx.services.config.mode,
        bootstrapAdminIds: apiCtx.services.bootstrapAdminIds,
      })
    } catch (err) {
      const message = getErrorMessage(err)
      canopyLogError(
        `CanopyCMS: Failed to resolve internal groups from the settings workspace: ${redactCredentials(message)}`,
      )

      // Same trade as the base-branch degradation above: /admin is the recovery
      // surface for exactly this failure (a renamed settings branch trips
      // assertSettingsWorkspaceIdentity until a human intervenes), so 503ing it
      // too would leave an operator no in-product way to see what is down.
      //
      // Safe because it can only REMOVE privilege, never grant it:
      // `authResultToCanopyUser` merges internal groups ADDITIVELY, and path
      // rules select on the user MATCHING a target, never on the user LACKING a
      // group, so dropping them flips allowed -> denied and not the reverse. The
      // one surviving privilege is bootstrap admin, which comes from
      // CANOPY_BOOTSTRAP_ADMIN_IDS and never touches the settings workspace.
      //
      // A non-bootstrap admin still gets the 503, deliberately: the admin guard
      // would answer them 403, and "settings workspace unavailable" is the more
      // actionable of the two.
      const degradedUser = authResultToCanopyUser(authResult, apiCtx.services.bootstrapAdminIds)
      if (pathSegments[0] === 'admin' && isAdmin(degradedUser.groups)) {
        canopyLogError(
          `CanopyCMS: Serving ${req.method} /admin for a bootstrap admin with group-based privileges UNRESOLVED (settings workspace unavailable) so the recovery endpoints stay reachable.`,
        )
        user = degradedUser
      } else {
        // Name the settings branch: this usually means a changed deploymentName
        // pointing the deployment at a branch other than the one its workspace
        // was cloned for, and the branch name is the part of that an operator
        // can act on without CloudWatch (paths are redacted from client-facing
        // messages).
        const settingsBranch = operatingStrategy(apiCtx.services.config.mode).getSettingsBranchName(
          apiCtx.services.config,
        )
        return jsonResponse(
          {
            ok: false,
            status: 503,
            error: `Settings workspace unavailable (settings branch '${settingsBranch}'): ${sanitizeErrorMessage(message)}`,
          },
          503,
        )
      }
    }

    if (user.type === 'anonymous') {
      return jsonResponse(
        { ok: false, status: 401, error: authResult.error ?? 'Unauthorized' },
        401,
      )
    }

    const queryParams = parseQueryParams(req.url)
    const mergedParams = { ...queryParams, ...match.params }

    // Multipart routes opt out via bodyFormat so their handler can read the
    // single-use body stream itself: calling req.json() first would consume it.
    let body: unknown
    if (req.method !== 'GET' && match.bodyFormat !== 'multipart') {
      try {
        body = await req.json()
      } catch {
        body = undefined
      }
    }

    const branch =
      (mergedParams as Record<string, string>)?.branch ??
      (body as Record<string, unknown> | undefined)?.branch
    const apiReq = { user, body, branch, query: queryParams, rawRequest: req }

    if (match.validate) {
      const validationResult = match.validate({ params: mergedParams, body })
      if (!validationResult.ok) {
        return jsonResponse({ ok: false, status: 400, error: validationResult.error }, 400)
      }

      const handlerArgs: unknown[] = [apiCtx, apiReq]
      if (validationResult.params !== undefined) {
        handlerArgs.push(validationResult.params)
      }
      if (validationResult.body !== undefined) {
        handlerArgs.push(validationResult.body)
      }

      const result = await match.handler(...handlerArgs)
      // Binary routes carry their own status and headers and MUST reach the
      // adapter untouched: jsonResponse would serialize raw bytes and drop
      // contentType/contentDisposition.
      if (isCanopyBinaryResponse(result)) return result
      return jsonResponse(result, result.status)
    } else {
      // Every route should use defineEndpoint; this is the safety net for one
      // that carries no validate function.
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

export async function createCanopyRequestHandlerFromConfig(
  options: { config: CanopyConfig } & Omit<CanopyHandlerOptions, 'services' | 'config'>,
): Promise<CanopyRequestHandler> {
  return createCanopyRequestHandler({
    ...options,
    services: await createCanopyServices(options.config),
  })
}
