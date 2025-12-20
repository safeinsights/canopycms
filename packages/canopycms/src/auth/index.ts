export type { AuthPlugin, AuthPluginFactory } from './plugin'
export type { AuthUser, UserSearchResult, GroupMetadata, TokenVerificationResult } from './types'

// Clerk provider
export { ClerkAuthPlugin, createClerkAuthPlugin } from './providers/clerk'
export type { ClerkAuthConfig } from './providers/clerk'
