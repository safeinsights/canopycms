/**
 * Path normalization utilities (client-safe).
 *
 * Consolidates the various path normalization patterns used across the codebase
 * into a single, well-tested module.
 *
 * NOTE: These functions are pure and can be used in both client and server code.
 * Server-only functions that depend on Node.js 'path' module are in normalize-server.ts.
 */

import type { LogicalPath, PhysicalPath } from './types'

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
 * Normalize a collection path by removing any content root prefix
 * and normalizing separators.
 *
 * @example
 * normalizeCollectionPath('content/posts') // 'posts'
 * normalizeCollectionPath('content\\blog\\posts') // 'blog/posts'
 * normalizeCollectionPath('posts') // 'posts'
 */
export function normalizeCollectionPath(collectionPath: string, contentRoot = 'content'): string {
  const normalized = normalizeFilesystemPath(collectionPath)
  const prefix = `${contentRoot}/`
  if (normalized.startsWith(prefix)) {
    return normalized.slice(prefix.length)
  }
  return normalized
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

