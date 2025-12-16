import type { BranchState, Role } from './types'
import type { UserContext, BranchAccessResult } from './authz'
import type { PathPermissionResult } from './path-permissions'

export interface ContentAccessResult {
  allowed: boolean
  branch: BranchAccessResult
  path: PathPermissionResult
}

export interface ContentAccessDeps {
  checkBranchAccess: (state: BranchState, user: UserContext) => BranchAccessResult
  checkPathAccess: (input: {
    relativePath: string
    userId: string
    groupIds?: string[]
    role?: Role
  }) => PathPermissionResult
}

export const checkContentAccess = (
  deps: ContentAccessDeps,
  branchState: BranchState,
  relativePath: string,
  user: UserContext
): ContentAccessResult => {
  const branch = deps.checkBranchAccess(branchState, user)
  const path = deps.checkPathAccess({
    relativePath,
    userId: user.userId,
    groupIds: user.groups,
    role: user.role,
  })

  return {
    allowed: branch.allowed && path.allowed,
    branch,
    path,
  }
}

export const createCheckContentAccess = (deps: ContentAccessDeps) => {
  return (branchState: BranchState, relativePath: string, user: UserContext): ContentAccessResult =>
    checkContentAccess(deps, branchState, relativePath, user)
}
