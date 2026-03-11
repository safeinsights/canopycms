/**
 * Test utilities for authorization types.
 *
 * These are unsafe casts with NO validation. Import only from test files.
 * For production code, use parsePermissionPath() instead.
 *
 * @example
 * // In test files only:
 * import { unsafeAsPermissionPath } from '../authorization/test-utils'
 */

import type { PermissionPath } from './types'

/** Test-only: cast a string to PermissionPath without validation. */
export const unsafeAsPermissionPath = (path: string): PermissionPath => path as PermissionPath
