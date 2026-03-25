import path from 'node:path'
import { cache } from 'react'
import { headers } from 'next/headers'
import {
  createCanopyContext,
  type CanopyContext,
  createCanopyServices,
  operatingStrategy,
  loadInternalGroups,
  loadBranchContext,
} from 'canopycms/server'
import type { CanopyConfig, AuthPlugin, CanopyUser, FieldConfig } from 'canopycms'
import { authResultToCanopyUser } from 'canopycms'
import type { InternalGroup } from 'canopycms/server'
import { CachingAuthPlugin, FileBasedAuthCache } from 'canopycms/auth/cache'
import { createCanopyCatchAllHandler } from './adapter'

let warnedNoAdmins = false

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

/**
 * Create Next.js-specific wrapper around core context.
 * Adds React cache() for per-request memoization and API handler.
 * This function is async because it needs to load .collection.json meta files.
 *
 * In prod/prod-sim mode, if the provided authPlugin implements verifyTokenOnly(),
 * it is automatically wrapped with CachingAuthPlugin + FileBasedAuthCache so that
 * auth works without network access (Lambda). The cache is populated by the worker daemon.
 */
export async function createNextCanopyContext(options: NextCanopyOptions) {
  // Fail fast: authPlugin is required for server deployments
  if (options.config.deployedAs !== 'static' && !options.authPlugin) {
    throw new Error(
      'CanopyCMS: authPlugin is required when deployedAs is "server". ' +
        'Set deployedAs: "static" in your canopy config, or provide an authPlugin.',
    )
  }

  // Warn when running in static deployment mode so it is not accidentally set in a server build
  if (options.config.deployedAs === 'static') {
    console.warn(
      'CanopyCMS: running in static deployment mode — all CMS API requests will return 401. ' +
        'Do not set deployedAs: "static" in a server deployment.',
    )
  }

  // Auto-wrap with CachingAuthPlugin for prod/prod-sim when plugin supports token-only verification.
  // This keeps auth networkless (required for Lambda) without exposing caching internals to adopters.
  const { mode } = options.config
  let resolvedPlugin = options.authPlugin
  if ((mode === 'prod' || mode === 'prod-sim') && options.authPlugin?.verifyTokenOnly) {
    const cachePath =
      process.env.CANOPY_AUTH_CACHE_PATH ??
      path.join(operatingStrategy(mode).getWorkspaceRoot(), '.cache')
    resolvedPlugin = new CachingAuthPlugin(
      (ctx) => options.authPlugin!.verifyTokenOnly!(ctx),
      new FileBasedAuthCache(cachePath),
    )
  }

  // Create services ONCE at initialization
  const services = await createCanopyServices(options.config, {
    entrySchemaRegistry: options.entrySchemaRegistry,
  })

  // User extractor: passes Next.js headers to auth plugin, loads internal groups, applies authorization
  // resolvedPlugin is guaranteed present for server deployments (validated at startup above)
  const extractUser = async (): Promise<CanopyUser> => {
    const headersList = await headers()
    const authResult = await resolvedPlugin!.authenticate(headersList)

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

  // Create API handler using same services — use stub auth plugin for static deployments
  const handler = createCanopyCatchAllHandler({
    ...options,
    authPlugin: resolvedPlugin ?? staticDeployAuthPlugin,
    services,
  })

  return {
    getCanopy,
    handler,
    services,
  }
}
