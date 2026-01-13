import type { BranchContext } from './types'
import type { BranchAccessResult } from './authz'
import type { PathPermissionResult } from './path-permissions'
import type { PathPermission, DefaultPathAccess, PermissionLevel } from './config'
import type { OperatingMode } from './operating-mode'
import { createCheckPathAccess } from './path-permissions'
import type { CanopyUser } from './user'
import { operatingStrategy } from './operating-mode'

export interface ContentAccessResult {
  allowed: boolean
  branch: BranchAccessResult
  path: PathPermissionResult
}

export interface ContentAccessDeps {
  checkBranchAccess: (context: BranchContext, user: CanopyUser) => BranchAccessResult
  loadPathPermissions: (branchRoot: string, mode: OperatingMode) => Promise<PathPermission[]>
  defaultPathAccess: DefaultPathAccess
  mode: OperatingMode
  /**
   * Get the settings branch root path for loading centralized permissions.
   * Only used in prod/local-prod-sim modes.
   * Must throw if settings branch cannot be loaded.
   */
  getSettingsBranchRoot?: () => Promise<string>
}

/**
 * Check content access by evaluating both branch and path permissions.
 * Path permissions are loaded dynamically from the branch root.
 */
export const checkContentAccess = async (
  deps: ContentAccessDeps,
  context: BranchContext,
  branchRoot: string,
  relativePath: string,
  user: CanopyUser,
  level: PermissionLevel,
): Promise<ContentAccessResult> => {
  const branch = deps.checkBranchAccess(context, user)

  // Load permissions from appropriate location based on operating mode
  // Modes with separate settings branch: load from settings branch
  // Other modes: load from the current branch
  let permissionsRoot = branchRoot
  const mode = deps.mode
  const strategy = operatingStrategy(mode)

  if (strategy.usesSeparateSettingsBranch()) {
    if (!deps.getSettingsBranchRoot) {
      throw new Error(
        'getSettingsBranchRoot is required for modes that use separate settings branch',
      )
    }
    // getSettingsBranchRoot must throw if it cannot load the settings branch
    // This ensures we never fall back to reading permissions from the current branch
    permissionsRoot = await deps.getSettingsBranchRoot()
  }

  const rules = await deps.loadPathPermissions(permissionsRoot, deps.mode)
  const pathChecker = createCheckPathAccess(rules, deps.defaultPathAccess)

  const path = pathChecker({
    relativePath,
    user,
    level,
  })

  return {
    allowed: branch.allowed && path.allowed,
    branch,
    path,
  }
}

export const createCheckContentAccess = (deps: ContentAccessDeps) => {
  return (
    context: BranchContext,
    branchRoot: string,
    relativePath: string,
    user: CanopyUser,
    level: PermissionLevel,
  ): Promise<ContentAccessResult> =>
    checkContentAccess(deps, context, branchRoot, relativePath, user, level)
}
