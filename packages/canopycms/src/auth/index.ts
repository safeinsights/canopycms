export type { AuthPlugin, AuthPluginFactory } from './plugin'
export type { AuthUser, UserSearchResult, GroupMetadata, TokenVerificationResult } from './types'

// Clerk provider - only type exports to avoid loading the module
export type { ClerkAuthConfig } from './providers/clerk'

/**
 * Lazy load Clerk auth plugin to avoid importing @clerk/nextjs when not needed.
 *
 * Usage:
 * ```ts
 * import { loadClerkAuthPlugin } from 'canopycms'
 *
 * const { createClerkAuthPlugin } = await loadClerkAuthPlugin()
 * const authPlugin = createClerkAuthPlugin({ secretKey: '...' })
 * ```
 */
export async function loadClerkAuthPlugin() {
  const mod = await import('./providers/clerk')
  return {
    ClerkAuthPlugin: mod.ClerkAuthPlugin,
    createClerkAuthPlugin: mod.createClerkAuthPlugin,
  }
}
