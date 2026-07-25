/**
 * Branch-level authorization
 *
 * Handles checking if a user can access a branch based on ACLs.
 */

import type { BranchContext } from '../types'
import type { DefaultBranchAccess } from '../config'
import { isAdmin, isReviewer } from './helpers'
import type { CanopyUser } from '../user'
import type { BranchAccessResult } from './types'

/**
 * Check if user has access to a branch with explicit default behavior.
 */
export function checkBranchAccessWithDefault(
  context: BranchContext,
  user: CanopyUser,
  defaultAccess: DefaultBranchAccess = 'deny',
): BranchAccessResult {
  // Admins and Reviewers have full branch access
  if (isAdmin(user.groups) || isReviewer(user.groups)) {
    return { allowed: true, reason: 'privileged' }
  }

  const access = context.branch.access
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

/**
 * Create a branch access checker with bound default access.
 */
export function createCheckBranchAccess(defaultAccess: DefaultBranchAccess = 'deny') {
  return (context: BranchContext, user: CanopyUser): BranchAccessResult =>
    checkBranchAccessWithDefault(context, user, defaultAccess)
}

/** Options tightening {@link canPerformWorkflowAction} beyond the default hybrid model. */
export interface WorkflowActionOptions {
  /**
   * When true, disables the system-branch grant below. The protected base
   * branch is auto-provisioned with `createdBy: 'canopycms-system'`, which
   * would otherwise let anyone with general branch access submit/withdraw it
   * -- pass `getBranchProtection(...).isProtected` here so only
   * admins/reviewers/explicit-ACL users retain workflow rights on it.
   */
  isProtectedBranch?: boolean
}

/**
 * Check if user can perform workflow actions (submit/withdraw) on a branch.
 * Allowed if: user is creator OR user has ACL access OR (system branch AND user has general access).
 *
 * This implements a hybrid permission model:
 * - Branch creators can always submit/withdraw their branches
 * - Users explicitly listed in branch ACLs can also submit/withdraw
 * - For system branches (createdBy: 'canopycms-system'), anyone with general access can submit/withdraw
 * - Admins and Reviewers always have access (via checkBranchAccess)
 * - Unless `options.isProtectedBranch` is set, in which case the system-branch
 *   grant above is disabled (see {@link WorkflowActionOptions})
 */
export function canPerformWorkflowAction(
  context: BranchContext,
  user: CanopyUser,
  defaultAccess: DefaultBranchAccess = 'deny',
  options?: WorkflowActionOptions,
): boolean {
  // Check if user has general branch access (handles admins, reviewers, ACLs)
  const accessResult = checkBranchAccessWithDefault(context, user, defaultAccess)

  // If user doesn't have basic branch access, deny immediately
  if (!accessResult.allowed) {
    return false
  }

  // Check if user is the branch creator
  const userIsCreator = context.branch.createdBy === user.userId

  // Check if this is a system-created branch (grant disabled on protected branches)
  const isSystemBranch =
    !options?.isProtectedBranch && context.branch.createdBy === 'canopycms-system'

  // Allow if:
  // 1. User is the creator, OR
  // 2. User has ACL access (reason: 'privileged' or 'allowed_by_acl'), OR
  // 3. System branch with general access
  return (
    userIsCreator ||
    accessResult.reason === 'privileged' ||
    accessResult.reason === 'allowed_by_acl' ||
    (isSystemBranch && accessResult.allowed)
  )
}
