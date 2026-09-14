export type { AuthPlugin, AuthPluginFactory } from './plugin'
export { assertAuthPluginAllowedForMode } from './plugin'
export type { UserSearchResult, GroupMetadata, AuthenticationResult } from './types'
export {
  isCanopyRequest,
  isHeadersLike,
  extractHeaders,
  validateAuthContext,
} from './context-helpers'
export type { HeadersLike } from './context-helpers'
// The server-only implementations are exported from 'canopycms/auth/cache'
// instead, to keep Node.js APIs out of client bundles.
export type { AuthCacheProvider, TokenVerifier } from './caching-auth-plugin'
