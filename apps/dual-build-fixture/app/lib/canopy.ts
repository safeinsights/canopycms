import { createNextCanopyContext } from 'canopycms-next'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

// Dev auth plugin -- this fixture only needs to prove the static/cms build
// split, not exercise a real auth provider. Anonymous reads are allowed via
// canopycms.config.ts's defaultPathAccess so the CMS build's `/` route can
// be curled without signing in first.
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin: createDevAuthPlugin(),
  entrySchemaRegistry,
})

// Phase-selecting read: admin build context (bypasses ACLs) during `next
// build`'s static-generation phase, branch-aware ACL-enforced context at
// request time. See README.md "Phase-Selecting readByUrlPath / read".
export const read = async <T = unknown>(input: {
  entryPath: string
  slug?: string
  branch?: string
  resolveReferences?: boolean
}) => {
  const context = await canopyContextPromise
  return context.read<T>(input)
}

// Export for the CMS-only catch-all API route (route.server.ts).
export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
