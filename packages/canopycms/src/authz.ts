import type { BranchState } from './types'
import type { DefaultBranchAccess } from './config'
import { isAdmin, isReviewer } from './reserved-groups'
import type { CanopyUser } from './user'

export interface BranchAccessResult {
  allowed: boolean
  reason: 'privileged' | 'allowed_by_acl' | 'denied_by_acl' | 'no_acl'
}

export const checkBranchAccessWithDefault = (
  state: BranchState,
  user: CanopyUser,
  defaultAccess: DefaultBranchAccess = 'deny',
): BranchAccessResult => {
  // Admins and Reviewers have full branch access
  if (isAdmin(user.groups) || isReviewer(user.groups)) {
    return { allowed: true, reason: 'privileged' }
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
  return (state: BranchState, user: CanopyUser): BranchAccessResult =>
    checkBranchAccessWithDefault(state, user, defaultAccess)
}
