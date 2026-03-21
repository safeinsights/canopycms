/**
 * Path type definitions for CanopyCMS
 *
 * These branded types provide compile-time safety to prevent accidentally
 * mixing logical paths (content/posts/my-post) with physical filesystem
 * paths (content/posts/my-post.ABC123.mdx).
 */

/**
 * A logical content path without embedded IDs.
 * Used in APIs, URLs, and user-facing contexts.
 * Example: "content/posts/my-post"
 */
export type LogicalPath = string & { readonly __brand: 'LogicalPath' }

/**
 * A physical filesystem path that may contain embedded IDs.
 * Used for actual file operations.
 * Example: "content/posts/my-post.ABC123.mdx"
 */
export type PhysicalPath = string & { readonly __brand: 'PhysicalPath' }

/**
 * A branch name that has been sanitized for filesystem use.
 */
export type SanitizedBranchName = string & { readonly __brand: 'SanitizedBranchName' }

/**
 * A git branch name (before sanitization for filesystem use).
 * Example: "feature/add-dark-mode" or "main"
 */
export type BranchName = string & { readonly __brand: 'BranchName' }

/**
 * A 12-character Base58-encoded content ID.
 * Used to uniquely identify entries and collections in filenames.
 * Example: "bChqT78gcaLd"
 */
export type ContentId = string & { readonly __brand: 'ContentId' }

/**
 * Sentinel ContentId for the root content directory (which has no embedded ID in its name).
 * Uses underscores — can never collide with real 12-char Base58 IDs (which exclude `_`).
 */
export const ROOT_COLLECTION_ID = '__rootcoll__' as ContentId

/**
 * A collection slug (validated segment of a collection path).
 * Example: "posts" or "api-docs"
 */
export type CollectionSlug = string & { readonly __brand: 'CollectionSlug' }

/**
 * An entry slug (last segment of an entry path, used in URLs and filenames).
 * Example: "my-first-post" or "getting-started"
 */
export type EntrySlug = string & { readonly __brand: 'EntrySlug' }

/**
 * Path validation result.
 */
export interface PathValidationResult {
  valid: boolean
  error?: string
  normalizedPath?: string
}
