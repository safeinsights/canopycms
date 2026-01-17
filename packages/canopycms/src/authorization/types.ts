/**
 * Authorization types for CanopyCMS
 *
 * This module exports all types related to authorization including
 * branch access, path permissions, and content access results.
 */

import type { CanopyUserId, CanopyGroupId } from '../types'

// Re-export types from other modules for convenience
export type { CanopyUserId, CanopyGroupId }

/**
 * Result of checking branch-level access
 */
export interface BranchAccessResult {
  allowed: boolean
  reason: 'privileged' | 'allowed_by_acl' | 'denied_by_acl' | 'no_acl'
}

/**
 * Result of checking path-level permissions
 */
export interface PathPermissionResult {
  allowed: boolean
  matchedRule?: import('../config').PathPermission
  reason?: string
}

/**
 * Combined result of checking both branch and path access
 */
export interface ContentAccessResult {
  allowed: boolean
  branch: BranchAccessResult
  path: PathPermissionResult
}

/**
 * Dependencies for content access checking
 */
export interface ContentAccessDeps {
  checkBranchAccess: (
    context: import('../types').BranchContext,
    user: import('../user').CanopyUser,
  ) => BranchAccessResult
  loadPathPermissions: (
    branchRoot: string,
    mode: import('../operating-mode').OperatingMode,
  ) => Promise<import('../config').PathPermission[]>
  defaultPathAccess: import('../config').DefaultPathAccess
  mode: import('../operating-mode').OperatingMode
  /**
   * Get the settings branch root path for loading centralized permissions.
   * Only used in prod/prod-sim modes.
   * Must throw if settings branch cannot be loaded.
   */
  getSettingsBranchRoot?: () => Promise<string>
}
