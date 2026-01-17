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
