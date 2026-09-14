/**
 * Branded path types. The brands exist to stop logical paths
 * (content/posts/my-post) being passed where physical filesystem paths
 * (content/posts/my-post.ABC123.mdx) are expected, and vice versa.
 */

/** A content path with no embedded IDs, as APIs and URLs carry it. */
export type LogicalPath = string & { readonly __brand: 'LogicalPath' }

/** A filesystem path, which may carry embedded IDs, as file operations need. */
export type PhysicalPath = string & { readonly __brand: 'PhysicalPath' }

/** A branch name already sanitized for filesystem use. */
export type SanitizedBranchName = string & {
  readonly __brand: 'SanitizedBranchName'
}

/** A git branch name, not yet sanitized: "feature/add-dark-mode", "main". */
export type BranchName = string & { readonly __brand: 'BranchName' }

/**
 * A 12-character Base58 content ID ("bChqT78gcaLd"), which uniquely identifies
 * an entry or collection within a filename.
 */
export type ContentId = string & { readonly __brand: 'ContentId' }

/**
 * Sentinel ContentId for the root content directory, whose name carries no
 * embedded ID. Underscores cannot collide with Base58 IDs, which exclude `_`.
 */
export const ROOT_COLLECTION_ID = '__rootcoll__' as ContentId

/** A validated, lowercase collection or entry slug: "my-first-post". */
export type Slug = string & { readonly __brand: 'Slug' }

export interface PathValidationResult {
  valid: boolean
  error?: string
  normalizedPath?: string
}
