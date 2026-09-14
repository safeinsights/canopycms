import type { CanopyUserId, CanopyGroupId } from '../types'

export type { CanopyUserId, CanopyGroupId }

/**
 * A path used in permission rules.
 * SECURITY CRITICAL: Always validated to prevent path traversal.
 * Example: "content/posts" or "content/settings/config"
 */
export type PermissionPath = string & { readonly __brand: 'PermissionPath' }

export interface BranchAccessResult {
  allowed: boolean
  reason: 'privileged' | 'base_branch' | 'creator' | 'allowed_by_acl' | 'denied_by_acl' | 'no_acl'
}

export interface PathPermissionResult {
  allowed: boolean
  matchedRule?: import('../config').PathPermission
  reason?: string
}

export interface ContentAccessResult {
  allowed: boolean
  branch: BranchAccessResult
  path: PathPermissionResult
}

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
   * Used in modes with a separate settings branch.
   * Must throw if settings branch cannot be loaded.
   */
  getSettingsBranchRoot?: () => Promise<string>
}
