import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin, createClerkJwtVerifier } from 'canopycms-auth-clerk'
import { createDevAuthPlugin, createDevTokenVerifier } from 'canopycms-auth-dev'
import type { AuthPlugin } from 'canopycms/auth'
import { CachingAuthPlugin, FileBasedAuthCache } from 'canopycms/auth/cache'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

/**
 * Select auth plugin based on operating mode and auth provider.
 *
 * prod / prod-sim: Use CachingAuthPlugin (networkless JWT + file-based cache).
 *   The cache is populated by the worker daemon (run-once or continuous).
 *
 * dev: Use auth plugin directly (no caching layer needed).
 */
function getAuthPlugin(): AuthPlugin {
  const mode = config.server.mode
  const authMode = process.env.CANOPY_AUTH_MODE || 'dev'

  // In prod/prod-sim: use CachingAuthPlugin to simulate/run the Lambda code path
  if (mode === 'prod' || mode === 'prod-sim') {
    const cachePath =
      process.env.CANOPY_AUTH_CACHE_PATH ??
      (mode === 'prod-sim' ? '.canopy-prod-sim/.cache' : '/mnt/efs/workspace/.cache')

    const tokenVerifier =
      authMode === 'clerk'
        ? createClerkJwtVerifier({ jwtKey: process.env.CLERK_JWT_KEY ?? '' })
        : createDevTokenVerifier()

    return new CachingAuthPlugin(tokenVerifier, new FileBasedAuthCache(cachePath))
  }

  // In dev mode: use auth plugin directly
  if (authMode === 'clerk') {
    return createClerkAuthPlugin({ useOrganizationsAsGroups: true })
  }

  return createDevAuthPlugin()
}

// Static deployments don't need auth — no HTTP requests, no users.
// Server deployments should provide authPlugin for authenticated reads.
const isStaticDeploy = config.server.deployedAs === 'static'

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  ...(!isStaticDeploy ? { authPlugin: getAuthPlugin() } : {}),
  entrySchemaRegistry,
})

// Export for server component pages
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Export for API routes
export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
