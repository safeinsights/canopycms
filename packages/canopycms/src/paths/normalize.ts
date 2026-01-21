/**
 * Path normalization utilities (client-safe).
 *
 * Consolidates the various path normalization patterns used across the codebase
 * into a single, well-tested module.
 *
 * NOTE: These functions are pure and can be used in both client and server code.
 * Server-only functions that depend on Node.js 'path' module are in normalize-server.ts.
 */

import type { CollectionPath, LogicalPath, PhysicalPath } from './types'

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

/**
 * Cast a string to LogicalPath type.
 * Use this when you have a string that you know is a logical path (no embedded IDs).
 * For constructing paths from segments, prefer createLogicalPath() which validates.
 *
 * @example
 * const logicalPath = toLogicalPath('content/authors')
 */
export function toLogicalPath(path: string): LogicalPath {
  return path as LogicalPath
}

/**
 * Cast a string to PhysicalPath type.
 * Use this when you have a string that you know is a physical path (may have embedded IDs).
 * For constructing paths from segments, prefer createPhysicalPath() which validates.
 *
 * @example
 * const physicalPath = toPhysicalPath('content/authors.q52DCVPuH4ga')
 */
export function toPhysicalPath(path: string): PhysicalPath {
  return path as PhysicalPath
}
