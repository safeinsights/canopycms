import { hasTraversalSequence } from '../paths/normalize'
import type { PermissionPath } from './types'

/** Parse a PermissionPath. SECURITY: rejects path traversal in permission rules. */
export function parsePermissionPath(
  path: string,
): { ok: true; path: PermissionPath } | { ok: false; error: string } {
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'Permission path is required' }
  }

  // SECURITY: Prevent path traversal attacks
  if (hasTraversalSequence(path)) {
    return {
      ok: false,
      error: 'Permission path contains traversal sequence (..)',
    }
  }

  // Normalize separators to prevent bypass via backslashes
  const normalized = path.replace(/\\/g, '/')

  if (normalized.startsWith('/') || normalized.endsWith('/')) {
    return {
      ok: false,
      error: 'Permission path cannot start or end with a slash',
    }
  }

  if (normalized.includes('//')) {
    return {
      ok: false,
      error: 'Permission path cannot contain consecutive slashes',
    }
  }

  return { ok: true, path: normalized as PermissionPath }
}
