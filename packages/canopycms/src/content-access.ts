import type { BranchState } from './types'
import type { UserContext, BranchAccessResult } from './authz'
import type { PathPermissionResult } from './path-permissions'
import type { PathPermission, DefaultPathAccess } from './config'
import { createCheckPathAccess } from './path-permissions'

export interface ContentAccessResult {
  allowed: boolean
  branch: BranchAccessResult
  path: PathPermissionResult
}

export interface ContentAccessDeps {
  checkBranchAccess: (state: BranchState, user: UserContext) => BranchAccessResult
  loadPathPermissions: (branchRoot: string) => Promise<PathPermission[]>
  defaultPathAccess: DefaultPathAccess
}

/**
 * Check content access by evaluating both branch and path permissions.
 * Path permissions are loaded dynamically from the branch root.
 */
export const checkContentAccess = async (
  deps: ContentAccessDeps,
  branchState: BranchState,
  branchRoot: string,
  relativePath: string,
  user: UserContext
): Promise<ContentAccessResult> => {
  const branch = deps.checkBranchAccess(branchState, user)

  const rules = await deps.loadPathPermissions(branchRoot)
  const pathChecker = createCheckPathAccess(rules, deps.defaultPathAccess)

  const path = pathChecker({
    relativePath,
    userId: user.userId,
    groupIds: user.groups,
  })

  return {
    allowed: branch.allowed && path.allowed,
    branch,
    path,
  }
}

export const createCheckContentAccess = (deps: ContentAccessDeps) => {
  return (
    branchState: BranchState,
    branchRoot: string,
    relativePath: string,
    user: UserContext
  ): Promise<ContentAccessResult> =>
    checkContentAccess(deps, branchState, branchRoot, relativePath, user)
}
