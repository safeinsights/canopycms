import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import config from '../../canopycms.config'

// Create unified context - used by both API routes and pages
const canopyContext = createNextCanopyContext({
  config: config.server,
  authPlugin: createClerkAuthPlugin({
    useOrganizationsAsGroups: true,
  }),
})

// Export for server component pages
export const getCanopy = canopyContext.getCanopy

// Export for API routes
export const handler = canopyContext.handler
