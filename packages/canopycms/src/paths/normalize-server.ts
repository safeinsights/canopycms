/**
 * Server-only path normalization utilities: these depend on `node:path` and
 * must not reach a client bundle. Client-safe equivalents are in normalize.ts.
 */

import { sep, resolve, relative } from 'node:path'
import type { PathValidationResult } from './types'

/** Normalize `target` relative to `root`, rejecting anything that escapes it. */
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
