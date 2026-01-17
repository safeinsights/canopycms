import { createNextCanopyContext } from 'canopycms-next'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'
import { schemaRegistry } from '../schemas'

/**
 * Dev auth plugin for local development and E2E testing.
 * - Supports user switching via X-Test-User header (for tests)
 * - Supports user switching via canopy-dev-user cookie (for UI)
 * - Compatible with existing test fixtures
 */
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin: createDevAuthPlugin(),
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
