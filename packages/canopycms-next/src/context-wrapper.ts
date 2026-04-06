import path from 'node:path'
import { cache } from 'react'
import { headers } from 'next/headers'
import {
  createCanopyContext,
  type CanopyContext,
  type CanopyBuildContext,
  type CanopyServices,
  createCanopyServices,
  operatingStrategy,
  loadInternalGroups,
  loadBranchContext,
  STATIC_DEPLOY_USER,
} from 'canopycms/server'
import type { CanopyConfig, AuthPlugin, CanopyUser, FieldConfig } from 'canopycms'
import { authResultToCanopyUser } from 'canopycms'
import type { InternalGroup } from 'canopycms/server'
import { CachingAuthPlugin, FileBasedAuthCache } from 'canopycms/auth/cache'
import { createCanopyCatchAllHandler } from './adapter'

let warnedNoAdmins = false
let warnedStaticMode = false

/**
 * Stub auth plugin for static deployments where no real auth is needed.
 * Returns unauthenticated for all requests — API routes will return 401.
 */
const staticDeployAuthPlugin: AuthPlugin = {
  async authenticate() {
    return { success: false as const, error: 'No auth plugin configured (static deployment)' }
  },
  async searchUsers() {
    return []
  },
  async getUserMetadata() {
    return null
  },
  async getGroupMetadata() {
    return null
  },
  async listGroups() {
    return []
  },
}

export interface NextCanopyOptions {
  config: CanopyConfig
  /** Auth plugin for user authentication. Optional for static deployments (deployedAs: 'static'). */
  authPlugin?: AuthPlugin
  entrySchemaRegistry: Record<string, readonly FieldConfig[]>
}

export interface NextCanopyContextResult {
  /** Request-scoped context. Uses headers() + React cache(). Call from server components and route handlers. */
  getCanopy: () => Promise<CanopyContext>
  /**
   * Build-time context. Uses STATIC_DEPLOY_USER (full admin, no auth), no request scope needed.
   * Safe to call from generateStaticParams, generateMetadata, and other non-request-scoped contexts.
   * Memoized for the process lifetime — multiple calls return the same context.
   *
   * Returns a narrower type than getCanopy() — only buildContentTree and listEntries are
   * available. read/readByUrlPath are excluded because build-time code should not perform
   * per-user content reads.
   *
   * **Security note:** This context bypasses all branch and path ACLs. It runs as a
   * synthetic admin user with unrestricted read access. Only use it in build-time
   * code paths that are not exposed to end users (e.g., static generation).
   */
  getCanopyForBuild: () => Promise<CanopyBuildContext>
  /** API catch-all route handler */
  handler: ReturnType<typeof createCanopyCatchAllHandler>
  /** Underlying services (rarely needed directly) */
  services: CanopyServices
}

/**
 * Create Next.js-specific wrapper around core context.
 * Adds React cache() for per-request memoization and API handler.
 * This function is async because it needs to load .collection.json meta files.
 *
 * In prod/dev mode, if the provided authPlugin implements verifyTokenOnly(),
 * it is automatically wrapped with CachingAuthPlugin + FileBasedAuthCache so that
 * auth works without network access (Lambda in prod, local in dev). The cache is populated by the worker daemon.
 */
export async function createNextCanopyContext(
  options: NextCanopyOptions,
): Promise<NextCanopyContextResult> {
  // Fail fast: authPlugin is required for server deployments
  if (options.config.deployedAs !== 'static' && !options.authPlugin) {
    throw new Error(
      'CanopyCMS: authPlugin is required when deployedAs is "server". ' +
        'Set deployedAs: "static" in your canopy config, or provide an authPlugin.',
    )
  }

  // Warn when running in static deployment mode so it is not accidentally set in a server build
  if (options.config.deployedAs === 'static' && !warnedStaticMode) {
    console.warn(
      'CanopyCMS: running in static deployment mode — all CMS API requests will return 401. ' +
        'Do not set deployedAs: "static" in a server deployment.',
    )
    warnedStaticMode = true
  }

  // Resolve the auth plugin: auto-wrap with CachingAuthPlugin for prod/dev when
  // the plugin supports token-only verification. This keeps auth networkless (required for
  // Lambda in prod, consistent in dev) without exposing caching internals to adopters.
  // For static deployments, use the stub that returns 401 for all requests.
  const { mode } = options.config
  const authPlugin: AuthPlugin = (() => {
    if (!options.authPlugin) return staticDeployAuthPlugin
    if ((mode === 'prod' || mode === 'dev') && options.authPlugin.verifyTokenOnly) {
      const cachePath =
        process.env.CANOPY_AUTH_CACHE_PATH ??
        path.join(operatingStrategy(mode).getWorkspaceRoot(), '.cache')
      // In dev mode, provide a lazy refresher so the cache is auto-populated
      // on first request without requiring manual `worker run-once`.
      const lazyRefresher =
        mode === 'dev' && options.authPlugin.createCacheRefresher
          ? options.authPlugin.createCacheRefresher(cachePath)
          : undefined
      return new CachingAuthPlugin(
        (ctx) => options.authPlugin!.verifyTokenOnly!(ctx),
        new FileBasedAuthCache(cachePath),
        lazyRefresher,
      )
    }
    return options.authPlugin
  })()

  // Create services ONCE at initialization
  const services = await createCanopyServices(options.config, {
    entrySchemaRegistry: options.entrySchemaRegistry,
  })

  // User extractor: passes Next.js headers to auth plugin, loads internal groups, applies authorization
  const extractUser = async (): Promise<CanopyUser> => {
    const headersList = await headers()
    const authResult = await authPlugin.authenticate(headersList)

    // Load internal groups from main branch
    const baseBranch = services.config.defaultBaseBranch ?? 'main'
    const operatingMode = services.config.mode ?? 'dev'
    const mainBranchContext = await loadBranchContext({
      branchName: baseBranch,
      mode: operatingMode,
    })
    const internalGroups: InternalGroup[] = mainBranchContext
      ? await loadInternalGroups(
          mainBranchContext.branchRoot,
          operatingMode,
          services.bootstrapAdminIds,
        ).catch((err: unknown) => {
          console.warn('CanopyCMS: Failed to load internal groups from main branch:', err)
          return [] as InternalGroup[]
        })
      : []

    if (!warnedNoAdmins && Array.isArray(internalGroups)) {
      const adminsGroup = internalGroups.find((g) => g.id === 'Admins')
      if (!adminsGroup || adminsGroup.members.length === 0) {
        console.warn(
          'CanopyCMS: No admin users configured. Set CANOPY_BOOTSTRAP_ADMIN_IDS or add members to the Admins group.',
        )
      }
      warnedNoAdmins = true
    }

    return authResultToCanopyUser(authResult, services.bootstrapAdminIds, internalGroups)
  }

  // Create core context with pre-created services (framework-agnostic)
  const coreContext = createCanopyContext({
    services,
    extractUser,
  })

  // Wrap with React cache() for per-request caching
  const getCanopy = cache((): Promise<CanopyContext> => {
    return coreContext.getContext()
  })

  // Build-time context: uses STATIC_DEPLOY_USER, no headers() call.
  // Safe for generateStaticParams, generateMetadata, and other non-request-scoped contexts.
  const buildContext = createCanopyContext({
    services,
    extractUser: async () => STATIC_DEPLOY_USER,
  })

  let buildContextPromise: Promise<CanopyBuildContext> | null = null
  const getCanopyForBuild = (): Promise<CanopyBuildContext> => {
    if (!buildContextPromise) {
      buildContextPromise = buildContext
        .getContext()
        .then(
          ({ buildContentTree, listEntries, services }): CanopyBuildContext => ({
            buildContentTree,
            listEntries,
            services,
          }),
        )
        .catch((err) => {
          buildContextPromise = null
          throw err
        })
    }
    return buildContextPromise
  }

  // Create API handler using same services
  const handler = createCanopyCatchAllHandler({
    ...options,
    authPlugin,
    services,
  })

  return {
    getCanopy,
    getCanopyForBuild,
    handler,
    services,
  }
}
