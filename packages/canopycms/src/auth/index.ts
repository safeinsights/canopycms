export type { AuthPlugin, AuthPluginFactory } from './plugin'
export type { UserSearchResult, GroupMetadata, AuthenticationResult } from './types'
export { isCanopyRequest, isHeadersLike, extractHeaders, validateAuthContext } from './context-helpers'
export type { HeadersLike } from './context-helpers'
// Server-only implementations (CachingAuthPlugin, FileBasedAuthCache, writeAuthCacheSnapshot)
// are exported via 'canopycms/auth/cache' to avoid pulling Node.js APIs into client bundles.
export type { AuthCacheProvider, TokenVerifier } from './caching-auth-plugin'
