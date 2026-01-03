import type { BranchContext } from './types'
import type { BranchAccessResult } from './authz'
import type { PathPermissionResult } from './path-permissions'
import type { PathPermission, DefaultPathAccess, PermissionLevel } from './config'
import { createCheckPathAccess } from './path-permissions'
import type { CanopyUser } from './user'

export interface ContentAccessResult {
  allowed: boolean
  branch: BranchAccessResult
  path: PathPermissionResult
}

export interface ContentAccessDeps {
  checkBranchAccess: (context: BranchContext, user: CanopyUser) => BranchAccessResult
  loadPathPermissions: (branchRoot: string) => Promise<PathPermission[]>
  defaultPathAccess: DefaultPathAccess
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

  const rules = await deps.loadPathPermissions(branchRoot)
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
