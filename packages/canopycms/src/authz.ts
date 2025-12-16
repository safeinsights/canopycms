import type { BranchState, CanopyGroupId, CanopyUserId, Role } from './types'
import type { DefaultBranchAccess } from './config'

export interface UserContext {
  userId: CanopyUserId
  groups?: CanopyGroupId[]
  role?: Role
}

export interface BranchAccessResult {
  allowed: boolean
  reason: 'admin_or_manager' | 'allowed_by_acl' | 'denied_by_acl' | 'no_acl'
}

export const checkBranchAccessWithDefault = (
  state: BranchState,
  user: UserContext,
  defaultAccess: DefaultBranchAccess = 'deny',
): BranchAccessResult => {
  const isPrivileged = user.role === 'admin' || user.role === 'manager'
  if (isPrivileged) {
    return { allowed: true, reason: 'admin_or_manager' }
  }

  const access = state.branch.access
  const hasUserConstraint = !!access.allowedUsers?.length
  const hasGroupConstraint = !!access.allowedGroups?.length
  const managerOrAdminAllowed = access.managerOrAdminAllowed ?? false

  if (!hasUserConstraint && !hasGroupConstraint) {
    if (managerOrAdminAllowed) {
      return { allowed: false, reason: 'denied_by_acl' }
    }
    const allowed = defaultAccess === 'allow'
    return { allowed, reason: 'no_acl' }
  }

  const userAllowed = hasUserConstraint && access.allowedUsers?.includes(user.userId)
  const groupAllowed =
    hasGroupConstraint && user.groups?.some((g) => access.allowedGroups?.includes(g))

  const allowed = Boolean(userAllowed || groupAllowed)
  return { allowed, reason: allowed ? 'allowed_by_acl' : 'denied_by_acl' }
}

export const createCheckBranchAccess = (defaultAccess: DefaultBranchAccess = 'deny') => {
  return (state: BranchState, user: UserContext): BranchAccessResult =>
    checkBranchAccessWithDefault(state, user, defaultAccess)
}
