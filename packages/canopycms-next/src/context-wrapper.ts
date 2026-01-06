import { cache } from 'react'
import { createCanopyContext, type CanopyContext } from 'canopycms/server'
import type { CanopyConfig, AuthPlugin } from 'canopycms'
import { createNextUserExtractor } from './user-extraction'
import { createCanopyCatchAllHandler } from './adapter'

export interface NextCanopyOptions {
  config: CanopyConfig
  authPlugin: AuthPlugin
}

/**
 * Create Next.js-specific wrapper around core context.
 * Adds React cache() for per-request memoization and API handler.
 */
export function createNextCanopyContext(options: NextCanopyOptions) {
  // Create core context (framework-agnostic)
  const coreContext = createCanopyContext({
    config: options.config,
    getUser: createNextUserExtractor(options.authPlugin),
  })

  // Wrap with React cache() for per-request caching
  const getCanopy = cache((): Promise<CanopyContext> => {
    return coreContext.getContext()
  })

  // Create API handler using same options
  const handler = createCanopyCatchAllHandler(options)

  return {
    getCanopy,
    handler,
    services: coreContext.services,
  }
}
