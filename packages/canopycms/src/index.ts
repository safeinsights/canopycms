export { sanitizeHref } from './utils/sanitize-href'
export * from './config'
export * from './entry-schema'
export * from './types'
export * from './user'
// Title-derivation fallback chain (schema isTitle field -> data.title/name -> entry-type label ->
// humanized slug -> "Untitled"). Client-safe: its only imports are types, erased at compile time.
// Exported from 'canopycms/server' too, so client list/preview UI and build scripts derive the
// same display title from one implementation.
export { resolveEntryTitle } from './utils/title-field'
// AI content config helper — client-safe (no node: imports).
// Server-only AI features (handler, generator) are in 'canopycms/ai'.
export { defineAIContentConfig } from './ai/types'
export type {
  AIContentConfig,
  ExcludeConfig,
  BundleConfig,
  BundleFilter,
  FieldTransformFn,
  FieldTransforms,
} from './ai/types'
// Client-safe auth types only; server-only implementations (CachingAuthPlugin, FileBasedAuthCache)
// live at 'canopycms/auth/cache'.
export type { AuthPlugin, AuthPluginFactory } from './auth/plugin'
export type { UserSearchResult, GroupMetadata, AuthenticationResult } from './auth/types'
export {
  isCanopyRequest,
  isHeadersLike,
  extractHeaders,
  validateAuthContext,
} from './auth/context-helpers'
export type { HeadersLike } from './auth/context-helpers'
export type {
  ContentTreeNode,
  BuildContentTreeOptions,
  ContentTreeExtractMeta,
  EntryTypeMap,
  DefaultEntryTypes,
} from './content-tree'
export type { ListEntriesItem, ListEntriesOptions } from './content-listing'
// Asset URL helpers — client-safe (no node: imports). Build/adjust transform URLs for <img>/srcset
// from stored asset refs without the server-only transform engine (assets/transform.ts, sharp).
export { assetUrl, assetSrcSet } from './assets/asset-url'
export type { AssetRef, AssetUrlOptions } from './assets/asset-url'
export type { OutputFormat, CropRect, TransformDirectives } from './assets/transform-directives'
