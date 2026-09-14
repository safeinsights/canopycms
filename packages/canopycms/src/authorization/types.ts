import type { CanopyUserId, CanopyGroupId } from '../types'

export type { CanopyUserId, CanopyGroupId }

/**
 * A path used in permission rules, e.g. "content/posts".
 * SECURITY CRITICAL: always validated to prevent path traversal.
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
   * Settings branch root for loading centralized permissions, in modes with a
   * separate settings branch. Must throw if it cannot be loaded.
   */
  getSettingsBranchRoot?: () => Promise<string>
}
