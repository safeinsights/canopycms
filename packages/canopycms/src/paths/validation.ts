/**
 * Path validation utilities.
 *
 * Security-focused validation for content paths and slugs.
 */

import { normalizeFilesystemPath, hasTraversalSequence } from './normalize'
import type {
  LogicalPath,
  PhysicalPath,
  ContentId,
  BranchName,
  EntrySlug,
  CollectionSlug,
} from './types'

/**
 * Base58 alphabet used for content IDs (excludes ambiguous: 0, O, I, l)
 */
const BASE58_PATTERN = '[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]'

/**
 * Pattern matching a 12-character content ID
 */
const CONTENT_ID_PATTERN = new RegExp(`${BASE58_PATTERN}{12}`)

/**
 * Pattern matching a physical path segment with embedded ID.
 * Matches patterns like:
 * - `post.my-slug.abc123def456.json` (entry)
 * - `posts.abc123def456` (collection directory)
 */
const PHYSICAL_SEGMENT_PATTERN = new RegExp(`\\.${BASE58_PATTERN}{12}(?:\\.[a-z]+)?$`)

/**
 * Validate a slug for use in content paths.
 * Slugs must not contain path separators or traversal sequences.
 *
 * @param slug - The slug to validate
 * @returns true if valid, false otherwise
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length === 0) {
    return false
  }

  // Max length (filesystem path safety)
  if (slug.length > 64) {
    return false
  }

  // No path separators
  if (slug.includes('/') || slug.includes('\\')) {
    return false
  }

  // No traversal
  if (slug === '.' || slug === '..') {
    return false
  }

  return true
}

/**
 * Validate a content path for security.
 *
 * @param path - The path to validate
 * @param rootPath - The root directory (for traversal check)
 * @returns Validation result
 */
export function validateContentPath(
  path: string,
  rootPath: string,
): { valid: boolean; error?: string } {
  const normalized = normalizeFilesystemPath(path)

  // Check for traversal sequences
  if (hasTraversalSequence(normalized)) {
    return { valid: false, error: 'Path contains traversal sequence' }
  }

  // Check path doesn't escape root
  const normalizedRoot = normalizeFilesystemPath(rootPath)
  if (!normalized.startsWith(normalizedRoot) && normalized !== normalizedRoot) {
    // Allow paths that are relative within the root
    const normalizedPath = `${normalizedRoot}/${normalized}`
    if (hasTraversalSequence(normalizedPath)) {
      return { valid: false, error: 'Path escapes root directory' }
    }
  }

  return { valid: true }
}

/**
 * Validate a collection ID.
 *
 * @param collectionId - The collection ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidCollectionId(collectionId: string): boolean {
  if (!collectionId || collectionId.length === 0) {
    return false
  }

  // Normalize and check for traversal
  const normalized = normalizeFilesystemPath(collectionId)
  if (hasTraversalSequence(normalized)) {
    return false
  }

  // Collection IDs should only contain alphanumeric, hyphens, underscores, and forward slashes
  const validPattern = /^[a-zA-Z0-9_/-]+$/
  return validPattern.test(normalized)
}

/**
 * Sanitize a string for use in paths by removing dangerous characters.
 *
 * @param input - The string to sanitize
 * @returns Sanitized string safe for path use
 */
export function sanitizeForPath(input: string): string {
  return input
    .replace(/[<>:"|?*\\]/g, '') // Remove invalid filesystem chars
    .replace(/\.{2,}/g, '.') // Collapse multiple dots
    .replace(/^\./, '') // Remove leading dot
    .trim()
}

/**
 * Check if a path segment contains an embedded content ID.
 *
 * Physical paths have segments with embedded 12-char IDs:
 * - `post.my-slug.abc123def456.json` (entry file)
 * - `posts.abc123def456` (collection directory)
 *
 * @param segment - A single path segment (no slashes)
 * @returns true if segment contains embedded ID pattern
 */
export function hasEmbeddedContentId(segment: string): boolean {
  return PHYSICAL_SEGMENT_PATTERN.test(segment)
}

/**
 * Check if a path appears to be a physical path (contains embedded content IDs).
 *
 * Physical paths have the format:
 * - `content/posts.abc123/post.hello.def456.json`
 *
 * Logical paths do not have embedded IDs:
 * - `content/posts/hello` or `posts/hello`
 *
 * @param path - The path to check
 * @returns true if any segment contains an embedded content ID
 */
export function looksLikePhysicalPath(path: string): boolean {
  const segments = path.split('/')
  return segments.some(hasEmbeddedContentId)
}

/**
 * Check if a path appears to be a logical path (no embedded content IDs).
 *
 * @param path - The path to check
 * @returns true if no segments contain embedded content IDs
 */
export function looksLikeLogicalPath(path: string): boolean {
  return !looksLikePhysicalPath(path)
}

/**
 * Validate and cast a string to LogicalPath.
 *
 * Use this at API boundaries to validate incoming path strings
 * and cast them to the branded LogicalPath type.
 *
 * @param path - The path string to validate
 * @returns Object with success flag and either the typed path or an error
 *
 * @example
 * ```ts
 * const result = parseLogicalPath(params.collectionPath)
 * if (!result.ok) {
 *   return { ok: false, status: 400, error: result.error }
 * }
 * const collectionPath: LogicalPath = result.path
 * ```
 */
export function parseLogicalPath(
  path: string,
): { ok: true; path: LogicalPath } | { ok: false; error: string } {
  // Basic validation
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'Path is required' }
  }

  // Security check
  if (hasTraversalSequence(path)) {
    return { ok: false, error: 'Path contains traversal sequence' }
  }

  // Check it's not a physical path
  if (looksLikePhysicalPath(path)) {
    return {
      ok: false,
      error:
        'Path appears to be a physical path (contains embedded content ID). Expected a logical path.',
    }
  }

  return { ok: true, path: path as LogicalPath }
}

/**
 * Validate and cast a string to PhysicalPath.
 *
 * Use this at API boundaries to validate incoming path strings
 * and cast them to the branded PhysicalPath type.
 *
 * @param path - The path string to validate
 * @returns Object with success flag and either the typed path or an error
 */
export function parsePhysicalPath(
  path: string,
): { ok: true; path: PhysicalPath } | { ok: false; error: string } {
  // Basic validation
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'Path is required' }
  }

  // Security check
  if (hasTraversalSequence(path)) {
    return { ok: false, error: 'Path contains traversal sequence' }
  }

  // Check it looks like a physical path
  if (!looksLikePhysicalPath(path)) {
    return {
      ok: false,
      error:
        'Path appears to be a logical path (no embedded content ID). Expected a physical path.',
    }
  }

  return { ok: true, path: path as PhysicalPath }
}

/**
 * Check if a string is a valid 12-character content ID.
 *
 * @param id - The string to check
 * @returns true if valid Base58 12-char ID
 */
export function isValidContentId(id: string): boolean {
  return CONTENT_ID_PATTERN.test(id) && id.length === 12
}

/**
 * Parse and validate a ContentId from a string.
 * Validates Base58 format and 12-character length.
 *
 * @param id - The string to validate
 * @returns Object with success flag and either the typed ID or an error
 *
 * @example
 * ```ts
 * const result = parseContentId(fileId)
 * if (!result.ok) {
 *   throw new Error(result.error)
 * }
 * const contentId: ContentId = result.id
 * ```
 */
export function parseContentId(
  id: string,
): { ok: true; id: ContentId } | { ok: false; error: string } {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Content ID is required' }
  }

  if (!isValidContentId(id)) {
    return {
      ok: false,
      error: `Invalid content ID format (expected 12 Base58 characters, got: ${id})`,
    }
  }

  return { ok: true, id: id as ContentId }
}

/**
 * Parse and validate a BranchName.
 * Checks git branch naming rules.
 *
 * @param name - The branch name to validate
 * @returns Object with success flag and either the typed name or an error
 *
 * @example
 * ```ts
 * const result = parseBranchName(params.branch)
 * if (!result.ok) {
 *   return { ok: false, status: 400, error: result.error }
 * }
 * const branchName: BranchName = result.name
 * ```
 */
export function parseBranchName(
  name: string,
): { ok: true; name: BranchName } | { ok: false; error: string } {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Branch name is required' }
  }

  // Git branch name rules
  if (name.includes('..')) {
    return { ok: false, error: 'Branch name cannot contain ".."' }
  }

  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return { ok: false, error: 'Invalid branch name format (invalid slashes)' }
  }

  if (name.includes(' ')) {
    return { ok: false, error: 'Branch name cannot contain spaces' }
  }

  // Additional git restrictions
  if (name.startsWith('.') || name.endsWith('.')) {
    return { ok: false, error: 'Branch name cannot start or end with a dot' }
  }

  if (name.includes('@{')) {
    return { ok: false, error: 'Branch name cannot contain "@{"' }
  }

  // Git-forbidden characters: ~ ^ : ? * [ \ and control chars
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(name)) {
    return { ok: false, error: 'Branch name contains invalid characters' }
  }

  if (name.endsWith('.lock')) {
    return { ok: false, error: 'Branch name cannot end with ".lock"' }
  }

  return { ok: true, name: name as BranchName }
}

/**
 * Parse and validate a slug (collection or entry).
 * Validates format and length constraints.
 *
 * @param slug - The slug to validate
 * @param type - Whether this is a collection or entry slug
 * @returns Object with success flag and either the typed slug or an error
 *
 * @example
 * ```ts
 * const result = parseSlug(params.slug, 'entry')
 * if (!result.ok) {
 *   return { ok: false, status: 400, error: result.error }
 * }
 * const entrySlug: EntrySlug = result.slug
 * ```
 */
export function parseSlug(
  slug: string,
  type: 'collection' | 'entry',
): { ok: true; slug: CollectionSlug | EntrySlug } | { ok: false; error: string } {
  if (!slug || typeof slug !== 'string') {
    return {
      ok: false,
      error: `${type === 'collection' ? 'Collection' : 'Entry'} slug is required`,
    }
  }

  // Check length first (before isValidSlug which also checks it)
  if (slug.length > 64) {
    return { ok: false, error: 'Slug too long (max 64 characters)' }
  }

  // Check for path separators and traversal
  if (slug.includes('/') || slug.includes('\\')) {
    return {
      ok: false,
      error: 'Slug cannot contain path separators',
    }
  }

  if (slug === '.' || slug === '..') {
    return {
      ok: false,
      error: 'Slug cannot be a traversal sequence',
    }
  }

  // Validation from ContentStore.renameEntry
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return {
      ok: false,
      error:
        'Slug must start with a letter or number and contain only lowercase letters, numbers, and hyphens',
    }
  }

  // Cast to appropriate branded type
  return { ok: true, slug: slug as CollectionSlug | EntrySlug }
}

/**
 * Convert a branded ContentId back to string for storage/serialization.
 * This is a type-safe way to extract the underlying string value.
 */
export function contentIdToString(id: ContentId): string {
  return id as string
}

/**
 * Convert a branded BranchName back to string for storage/serialization.
 */
export function branchNameToString(name: BranchName): string {
  return name as string
}

/**
 * Convert a branded slug back to string for storage/serialization.
 */
export function slugToString(slug: CollectionSlug | EntrySlug): string {
  return slug as string
}
