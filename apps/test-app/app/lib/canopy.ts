import { createNextCanopyContext, type GenerateContentStaticParamsOptions } from 'canopycms-next'
import { createDevAuthPlugin } from 'canopycms-auth-dev'
import config from '../../canopycms.config'
import { entrySchemaRegistry } from '../schemas'

/**
 * Dev auth plugin for local development and E2E testing.
 * - Supports user switching via X-Test-User header (for tests)
 * - Supports user switching via canopy-dev-user cookie (for UI)
 * - Compatible with existing test fixtures
 */
const canopyContextPromise = createNextCanopyContext({
  config: config.server,
  authPlugin: createDevAuthPlugin(),
  entrySchemaRegistry,
})

// Export for server component pages
export const getCanopy = async () => {
  const context = await canopyContextPromise
  return context.getCanopy()
}

// Phase-selecting reads: filesystem-direct at build time, branch-aware (ACL-enforced) at request time.
export const readByUrlPath = async <T = unknown>(
  urlPath: string,
  options?: { branch?: string; resolveReferences?: boolean },
) => {
  const context = await canopyContextPromise
  return context.readByUrlPath<T>(urlPath, options)
}

export const read = async <T = unknown>(input: {
  entryPath: string
  slug?: string
  branch?: string
  resolveReferences?: boolean
}) => {
  const context = await canopyContextPromise
  return context.read<T>(input)
}

// Enumeration-only static params — no admin build context exposed to page modules.
export const generateContentStaticParams = async (options?: GenerateContentStaticParamsOptions) => {
  const context = await canopyContextPromise
  return context.generateContentStaticParams(options)
}

// Export for API routes
export const getHandler = async () => {
  const context = await canopyContextPromise
  return context.handler
}
