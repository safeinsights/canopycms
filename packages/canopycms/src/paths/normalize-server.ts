/**
 * Server-only path normalization utilities.
 *
 * These functions depend on Node.js 'path' module and cannot be used in client code.
 * Client-safe functions are in normalize.ts.
 */

import { sep, resolve, relative } from 'node:path'
import type { PathValidationResult } from './types'

/**
 * Validate and normalize a path relative to a root directory.
 * Checks for path traversal attacks.
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
