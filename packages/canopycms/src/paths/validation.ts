/**
 * Path validation utilities.
 *
 * Security-focused validation for content paths and slugs.
 */

import { normalizeFilesystemPath, hasTraversalSequence } from './normalize'

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
