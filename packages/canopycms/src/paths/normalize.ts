/**
 * Path normalization utilities.
 *
 * Consolidates the various path normalization patterns used across the codebase
 * into a single, well-tested module.
 */

import { sep, resolve, relative } from 'path'
import type { CollectionPath, LogicalPath, PhysicalPath, PathValidationResult } from './types'

/**
 * Normalize a filesystem path by:
 * - Converting backslashes to forward slashes
 * - Removing empty segments
 * - Removing leading/trailing slashes
 *
 * This is the foundational normalization used by most path operations.
 *
 * @example
 * normalizeFilesystemPath('content\\posts\\\\my-post') // 'content/posts/my-post'
 * normalizeFilesystemPath('/content/posts/') // 'content/posts'
 */
export function normalizeFilesystemPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
}

/**
 * Normalize a collection ID by removing any content root prefix
 * and normalizing separators.
 *
 * @example
 * normalizeCollectionId('content/posts') // 'posts'
 * normalizeCollectionId('content\\blog\\posts') // 'blog/posts'
 * normalizeCollectionId('posts') // 'posts'
 */
export function normalizeCollectionId(
  collectionId: string,
  contentRoot = 'content',
): CollectionPath {
  const normalized = normalizeFilesystemPath(collectionId)
  const prefix = `${contentRoot}/`
  if (normalized.startsWith(prefix)) {
    return normalized.slice(prefix.length) as CollectionPath
  }
  return normalized as CollectionPath
}

/**
 * Validate and normalize a path relative to a root directory.
 * Checks for path traversal attacks.
 *
 * @param root - The root directory
 * @param target - The target path to validate
 * @returns Validation result with normalized relative path if valid
 */
export function validateAndNormalizePath(root: string, target: string): PathValidationResult {
  const resolvedRoot = resolve(root)
  const withSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`
  const resolvedTarget = resolve(target)

  if (!resolvedTarget.startsWith(withSep) && resolvedTarget !== resolvedRoot) {
    return {
      valid: false,
      error: 'Path traversal detected',
    }
  }

  const relativePath = relative(resolvedRoot, resolvedTarget).split(sep).join('/')

  return {
    valid: true,
    normalizedPath: relativePath,
  }
}

/**
 * Check if a path contains traversal sequences (.., etc.)
 */
export function hasTraversalSequence(path: string): boolean {
  const normalized = normalizeFilesystemPath(path)
  return normalized.includes('..')
}

/**
 * Create a logical path from segments.
 * Validates that no segment contains path traversal.
 *
 * @example
 * createLogicalPath('content', 'posts', 'my-post') // 'content/posts/my-post' as LogicalPath
 */
export function createLogicalPath(...segments: string[]): LogicalPath {
  const normalized = segments
    .map((s) => normalizeFilesystemPath(s))
    .filter(Boolean)
    .join('/')

  if (hasTraversalSequence(normalized)) {
    throw new Error(`Invalid path: contains traversal sequence: ${normalized}`)
  }

  return normalized as LogicalPath
}

/**
 * Create a physical path from segments.
 * This is for paths that may contain embedded IDs.
 *
 * @example
 * createPhysicalPath('content', 'posts', 'my-post.ABC123.mdx') // as PhysicalPath
 */
export function createPhysicalPath(...segments: string[]): PhysicalPath {
  const normalized = segments
    .map((s) => normalizeFilesystemPath(s))
    .filter(Boolean)
    .join('/')

  if (hasTraversalSequence(normalized)) {
    throw new Error(`Invalid path: contains traversal sequence: ${normalized}`)
  }

  return normalized as PhysicalPath
}

/**
 * Convert a LogicalPath to a string (for passing to APIs that expect plain strings).
 */
export function logicalPathToString(path: LogicalPath): string {
  return path as string
}

/**
 * Convert a PhysicalPath to a string (for passing to APIs that expect plain strings).
 */
export function physicalPathToString(path: PhysicalPath): string {
  return path as string
}

/**
 * Join path segments with forward slashes.
 * Does not validate - use createLogicalPath/createPhysicalPath for validation.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => normalizeFilesystemPath(s))
    .filter(Boolean)
    .join('/')
}
