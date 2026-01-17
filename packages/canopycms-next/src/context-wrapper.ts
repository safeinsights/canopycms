import { cache } from 'react'
import { headers } from 'next/headers'
import { createCanopyContext, type CanopyContext, createCanopyServices } from 'canopycms/server'
import type { CanopyConfig, AuthPlugin, CanopyUser, FieldConfig } from 'canopycms'
import { authResultToCanopyUser } from 'canopycms'
import { loadInternalGroups, loadBranchContext } from 'canopycms/server'
import { createCanopyCatchAllHandler } from './adapter'

export interface NextCanopyOptions {
  config: CanopyConfig
  authPlugin: AuthPlugin
  schemaRegistry: Record<string, readonly FieldConfig[]>
}

/**
 * Create Next.js-specific wrapper around core context.
 * Adds React cache() for per-request memoization and API handler.
 * This function is async because it needs to load .collection.json meta files.
 */
export async function createNextCanopyContext(options: NextCanopyOptions) {
  // Create services ONCE at initialization
  const services = await createCanopyServices(options.config, {
    schemaRegistry: options.schemaRegistry,
  })

  // User extractor: passes Next.js headers to auth plugin, loads internal groups, applies authorization
  const extractUser = async (): Promise<CanopyUser> => {
    const headersList = await headers()
    const authResult = await options.authPlugin.authenticate(headersList)

    // Load internal groups from main branch
    const baseBranch = services.config.defaultBaseBranch ?? 'main'
    const operatingMode = services.config.mode ?? 'dev'
    const mainBranchContext = await loadBranchContext({
      branchName: baseBranch,
      mode: operatingMode,
    })
    const internalGroups = mainBranchContext
      ? await loadInternalGroups(
          mainBranchContext.branchRoot,
          operatingMode,
          services.bootstrapAdminIds,
        ).catch(() => [])
      : []

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

  // Create API handler using same services
  const handler = createCanopyCatchAllHandler({
    ...options,
    services,
  })

  return {
    getCanopy,
    handler,
    services,
  }
}
