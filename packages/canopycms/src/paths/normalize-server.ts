/**
 * Server-only path normalization utilities.
 *
 * These functions depend on Node.js 'path' module and cannot be used in client code.
 * Client-safe functions are in normalize.ts.
 */

import { sep, resolve, relative } from 'path'
import type { PathValidationResult } from './types'

/**
 * Validate and normalize a path relative to a root directory.
 * Checks for path traversal attacks.
 *
 * NOTE: This function uses Node.js path module and is server-only.
 * For client code, use the pure functions in normalize.ts.
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

  const relativePath = relative(resolvedRoot, resolvedTarget)
    .split(sep)
    .join('/')

  return {
    valid: true,
    normalizedPath: relativePath,
  }
}
