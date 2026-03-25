import { createNextCanopyContext } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin:
    process.env.CANOPY_AUTH_MODE === 'clerk'
      ? createClerkAuthPlugin({ useOrganizationsAsGroups: true })
      : createDevAuthPlugin(),
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
