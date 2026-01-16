import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import type { AuthPlugin } from 'canopycms/auth'
import config from '../../canopycms.config'
import { schemaRegistry } from '../schemas'

/**
 * Select auth plugin based on CANOPY_AUTH_MODE environment variable.
 * - 'dev' (default): Use dev auth plugin (no real authentication)
 * - 'clerk': Use Clerk authentication
 */
function getAuthPlugin(): AuthPlugin {
  const authMode = process.env.CANOPY_AUTH_MODE || 'dev'

  if (authMode === 'dev') {
    return createDevAuthPlugin()
  }

  if (authMode === 'clerk') {
    return createClerkAuthPlugin({
      useOrganizationsAsGroups: true,
    })
  }

  throw new Error(`Invalid CANOPY_AUTH_MODE: "${authMode}". Must be "dev" or "clerk".`)
}

// Create unified context - used by both API routes and pages
// This is async because it loads .collection.json meta files
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin: getAuthPlugin(),
  schemaRegistry,
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
