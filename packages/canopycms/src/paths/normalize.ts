/**
 * Path normalization utilities. Pure, so client-safe; the ones that need
 * `node:path` live in normalize-server.ts.
 */

import type { LogicalPath, PhysicalPath } from './types'

/**
 * Split on either separator, dropping empty segments, and rejoin with `/`:
 * backslashes become forward slashes and leading/trailing/repeated slashes go.
 * Most other path operations here build on it.
 *
 * @example
 * normalizeFilesystemPath('content\\posts\\\\my-post') // 'content/posts/my-post'
 */
export function normalizeFilesystemPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
}

/**
 * Normalize separators and strip any leading content-root prefix.
 *
 * @example
 * normalizeCollectionPath('content\\blog\\posts') // 'blog/posts'
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

/** Join segments into a LogicalPath, throwing on a traversal sequence. */
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
 * Join segments into a PhysicalPath (segments may carry embedded content IDs,
 * e.g. `my-post.ABC123.mdx`), throwing on a traversal sequence.
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
 * Strip leading and trailing slashes from a path or URL segment.
 *
 * @example
 * trimSlashes('///multi///') // 'multi'
 */
export function trimSlashes(path: string): string {
  // Linear scan instead of regex to avoid polynomial ReDoS on repeated '/' chars
  let start = 0
  let end = path.length
  while (start < end && path[start] === '/') start++
  while (end > start && path[end - 1] === '/') end--
  return path.slice(start, end)
}

/**
 * Join path segments with forward slashes. Does NOT check for traversal --
 * use createLogicalPath/createPhysicalPath where the result is used as a path.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => normalizeFilesystemPath(s))
    .filter(Boolean)
    .join('/')
}
