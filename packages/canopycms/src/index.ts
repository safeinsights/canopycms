export * from './config'
export * from './entry-schema'
export * from './types'
export * from './user'
// Only re-export client-safe types from auth. Server-only implementations
// (CachingAuthPlugin, FileBasedAuthCache) are available via 'canopycms/auth/cache'.
export type { AuthPlugin, AuthPluginFactory } from './auth/plugin'
export type { UserSearchResult, GroupMetadata, AuthenticationResult } from './auth/types'
export { isCanopyRequest, isHeadersLike, extractHeaders, validateAuthContext } from './auth/context-helpers'
export type { HeadersLike } from './auth/context-helpers'
