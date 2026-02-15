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
 * A normalized collection ID path (no content/ prefix, forward slashes).
 * Example: "posts" or "blog/posts"
 */
export type CollectionPath = string & { readonly __brand: 'CollectionPath' }

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
 * Context for path resolution operations.
 */
export interface PathContext {
  /** Root directory for content (e.g., "content") */
  contentRoot: string
  /** Base directory for branch workspace */
  workspaceRoot: string
  /** Current branch name */
  branch?: string
}

/**
 * Path validation result.
 */
export interface PathValidationResult {
  valid: boolean
  error?: string
  normalizedPath?: string
}
