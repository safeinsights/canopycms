import { cache } from 'react'
import { headers } from 'next/headers'
import { createCanopyContext, type CanopyContext, createCanopyServices } from 'canopycms/server'
import type { CanopyConfig, AuthPlugin, CanopyUser, FieldConfig } from 'canopycms'
import { authResultToCanopyUser } from 'canopycms'
import { loadInternalGroups, loadBranchContext } from 'canopycms/server'
import type { InternalGroup } from 'canopycms/server'
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
 */
export async function createNextCanopyContext(options: NextCanopyOptions) {
  // Create services ONCE at initialization
  const services = await createCanopyServices(options.config, {
    entrySchemaRegistry: options.entrySchemaRegistry,
  })

  // User extractor: passes Next.js headers to auth plugin, loads internal groups, applies authorization
  const extractUser = async (): Promise<CanopyUser> => {
    if (!options.authPlugin) {
      throw new Error(
        'CanopyCMS: authPlugin is required when deployedAs is "server". ' +
          'Set deployedAs: "static" in your canopy config, or provide an authPlugin.',
      )
    }

    const headersList = await headers()
    const authResult = await options.authPlugin.authenticate(headersList)

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
    authPlugin: options.authPlugin ?? staticDeployAuthPlugin,
    services,
  })

  return {
    getCanopy,
    handler,
    services,
  }
}
