/**
 * Authorization validation utilities.
 *
 * SECURITY CRITICAL: These functions validate permission paths
 * to prevent path traversal attacks.
 */

import { hasTraversalSequence } from '../paths'
import type { PermissionPath } from './types'

/**
 * Parse and validate a PermissionPath.
 *
 * SECURITY: Prevents path traversal attacks in permission rules.
 *
 * @param path - The permission path to validate
 * @returns Object with success flag and either the typed path or an error
 *
 * @example
 * ```ts
 * const result = parsePermissionPath(rule.path)
 * if (!result.ok) {
 *   throw new Error(`Invalid permission path: ${result.error}`)
 * }
 * const permissionPath: PermissionPath = result.path
 * ```
 */
export function parsePermissionPath(path: string):
  | { ok: true; path: PermissionPath }
  | { ok: false; error: string } {
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'Permission path is required' }
  }

  // SECURITY: Prevent path traversal attacks
  if (hasTraversalSequence(path)) {
    return {
      ok: false,
      error: 'Permission path contains traversal sequence (..)'
    }
  }

  // Normalize separators to prevent bypass via backslashes
  const normalized = path.replace(/\\/g, '/')

  // Additional security checks
  if (normalized.startsWith('/') || normalized.endsWith('/')) {
    return {
      ok: false,
      error: 'Permission path cannot start or end with a slash'
    }
  }

  if (normalized.includes('//')) {
    return {
      ok: false,
      error: 'Permission path cannot contain consecutive slashes'
    }
  }

  return { ok: true, path: normalized as PermissionPath }
}

/**
 * Convert a branded PermissionPath back to string for storage/serialization.
 */
export function permissionPathToString(path: PermissionPath): string {
  return path as string
}

