import {
  createNextCanopyContext,
  type GenerateContentStaticParamsOptions,
  type NextCanopyContextResult,
} from 'canopycms-next'
import { createClerkAuthPlugin } from 'canopycms-auth-clerk'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

// Auth plugin selection — fails closed. The dev plugin performs NO real credential
// verification, so it is only ever used when mode is 'dev'. In prod, Clerk is always
// used: if CLERK_SECRET_KEY is missing, createClerkAuthPlugin throws at the first
// authenticated request (construction is cheap, so the zero-editor static build can
// import canopy.ts without the secret), instead of silently falling back to
// unauthenticated dev auth.
const authPlugin =
  config.server.mode === 'prod' || process.env.CANOPY_AUTH_MODE === 'clerk'
    ? createClerkAuthPlugin({ useOrganizationsAsGroups: true })
    : createDevAuthPlugin()

const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin,
  entrySchemaRegistry,
})

// Export for server component pages
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Phase-selecting reads: filesystem-direct at build time, branch-aware (ACL-enforced) at request time.
// Recommended for resolving a page by URL/path in a [...slug] / [slug] route — correct in both phases.
export const readByUrlPath: NextCanopyContextResult['readByUrlPath'] = async <T = unknown>(
  urlPath: string,
  options?: { branch?: string; resolveReferences?: boolean },
) => {
  const context = await canopyContextPromise
  return context.readByUrlPath<T>(urlPath, options)
}

export const read: NextCanopyContextResult['read'] = async <T = unknown>(input: {
  entryPath: string
  slug?: string
  branch?: string
  resolveReferences?: boolean
}) => {
  const context = await canopyContextPromise
  return context.read<T>(input)
}

// Enumeration-only static params — no admin build context exposed to page modules.
export const contentStaticParams = async (options?: GenerateContentStaticParamsOptions) => {
  const context = await canopyContextPromise
  return context.generateContentStaticParams(options)
}

// Advanced escape hatch: the build context bypasses all ACLs (synthetic admin) and throws if used at
// request time on a production server. Prefer readByUrlPath/read/contentStaticParams above.
export const getCanopyForBuild = async () => {
  const context = await canopyContextPromise
  return context.getCanopyForBuild()
}

// Export for API routes
export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
