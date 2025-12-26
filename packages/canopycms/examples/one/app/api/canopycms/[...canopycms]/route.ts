import configBundle from '../../../../canopycms.config'
import { createCanopyHandler } from 'canopycms/next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'

const handler = createCanopyHandler({
  config: configBundle.server,
  authPlugin: createClerkAuthPlugin({
    secretKey: process.env.CLERK_SECRET_KEY,
    roleMetadataKey: 'canopyRole',
    useOrganizationsAsGroups: true,
  }),
})

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
