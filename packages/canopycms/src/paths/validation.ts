/**
 * Path validation utilities.
 *
 * Security-focused validation for content paths and slugs.
 */

import { normalizeFilesystemPath, hasTraversalSequence, toLogicalPath, toPhysicalPath } from './normalize'
import type { LogicalPath, PhysicalPath } from './types'

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
const PHYSICAL_SEGMENT_PATTERN = new RegExp(
  `\\.${BASE58_PATTERN}{12}(?:\\.[a-z]+)?$`
)

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
  rootPath: string
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
export function parseLogicalPath(path: string):
  | { ok: true; path: LogicalPath }
  | { ok: false; error: string } {
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
      error: 'Path appears to be a physical path (contains embedded content ID). Expected a logical path.'
    }
  }

  return { ok: true, path: toLogicalPath(path) }
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
export function parsePhysicalPath(path: string):
  | { ok: true; path: PhysicalPath }
  | { ok: false; error: string } {
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
      error: 'Path appears to be a logical path (no embedded content ID). Expected a physical path.'
    }
  }

  return { ok: true, path: toPhysicalPath(path) }
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
