import { createNextCanopyContext } from 'canopycms-next'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'

/**
 * Dev auth plugin for local development and E2E testing.
 * - Supports user switching via X-Test-User header (for tests)
 * - Supports user switching via canopy-dev-user cookie (for UI)
 * - Compatible with existing test fixtures
 */
const canopyContext = createNextCanopyContext({
  config: config.server,
  authPlugin: createDevAuthPlugin(),
})

export const getCanopy = canopyContext.getCanopy
export const handler = canopyContext.handler
