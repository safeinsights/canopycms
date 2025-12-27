import configBundle from '../../../../canopycms.config'
import { createCanopyCatchAllHandler } from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'

const handler = createCanopyCatchAllHandler({
  config: configBundle.server,
  authPlugin: createClerkAuthPlugin({
    useOrganizationsAsGroups: true,
  }),
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
