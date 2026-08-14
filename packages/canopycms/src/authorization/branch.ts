/**
 * Branch-level authorization
 *
 * Handles checking if a user can access a branch based on ACLs.
 */

import type { BranchContext } from '../types'
import type { CanopyConfig, DefaultBranchAccess } from '../config'
import { isAdmin, isReviewer } from './helpers'
import { getBranchProtection } from './protected-branch'
import type { CanopyUser } from '../user'
import type { BranchAccessResult } from './types'

/** Options narrowing {@link checkBranchAccessWithDefault} to a specific branch's nature. */
export interface BranchAccessOptions {
  /**
   * Whether this is the protected base branch -- pass
   * `getBranchProtection(...).isProtected`. When true, the branch passes this
   * layer wherever no explicit ACL decided the question, and the PATH layer alone
   * decides what is readable. Explicit ACL verdicts still win in both directions
   * (see the comment at the fallback site).
   *
   * This grant is load-bearing, not a convenience. The base branch takes no ACL
   * (`updateBranchAccessHandler` rejects one outright, because an entry there
   * would feed `allowed_by_acl` and confer Withdraw rights) and its `createdBy`
   * is `canopycms-system`, so nobody is its creator. Without this, the branch
   * every user lands on is unreachable under `defaultBranchAccess: 'deny'` with
   * no way to configure around it -- which is what made 'deny' unusable for any
   * site with non-admin editors.
   *
   * It cannot widen anything dangerous: workflow actions stay blocked because
   * {@link canPerformWorkflowAction} disables its system-branch grant on the
   * same flag, prod writes stay blocked by `getBranchWriteProtection().readOnly`,
   * and the editor API 401s anonymous callers before authorization runs. What it
   * buys is that a public-read `deployedAs: 'server'` site can run 'deny' with
   * `defaultPathAccess: { read: 'allow' }` and still keep un-ACL'd work branches
   * private -- previously that required the blunt `defaultBranchAccess: 'allow'`,
   * which opened every work branch too.
   */
  isProtectedBranch?: boolean
}

/**
 * Check if user has access to a branch with explicit default behavior.
 *
 * Precedence, highest first:
 * 1. Admins and Reviewers
 * 2. `managerOrAdminAllowed` lockdown
 * 3. An explicit user/group ACL -- an allowlist omitting the creator still
 *    denies them, so an admin can lock down a branch someone else created
 * 4. With no ACL: the branch creator, then `defaultAccess`, and only where that
 *    would deny, the protected base branch grant
 *    (see {@link BranchAccessOptions.isProtectedBranch})
 */
export function checkBranchAccessWithDefault(
  context: BranchContext,
  user: CanopyUser,
  defaultAccess: DefaultBranchAccess = 'deny',
  options?: BranchAccessOptions,
): BranchAccessResult {
  // Admins and Reviewers have full branch access
  if (isAdmin(user.groups) || isReviewer(user.groups)) {
    return { allowed: true, reason: 'privileged' }
  }

  const access = context.branch.access
  const hasUserConstraint = !!access.allowedUsers?.length
  const hasGroupConstraint = !!access.allowedGroups?.length
  const managerOrAdminAllowed = access.managerOrAdminAllowed ?? false

  if (!hasUserConstraint && !hasGroupConstraint && managerOrAdminAllowed) {
    return { allowed: false, reason: 'denied_by_acl' }
  }

  if (!hasUserConstraint && !hasGroupConstraint) {
    // The branch creator owns their own un-ACL'd branch. This matches the three
    // places the server already grants on creator-ownership independently of
    // branch access (listBranchesHandler, canDeleteBranch, canModifyBranchAccess)
    // -- without it, under 'deny' a creator could delete their branch and rewrite
    // its ACL but not read a single file on it.
    //
    // Deliberately scoped to the no-ACL case: an EXPLICIT allowlist that omits
    // the creator still denies them, because that is how an admin locks down a
    // branch someone else created. Granting creator ahead of the ACL would make
    // that lockdown silently ineffective.
    if (context.branch.createdBy === user.userId) {
      return { allowed: true, reason: 'creator' }
    }
    if (defaultAccess === 'allow') {
      return { allowed: true, reason: 'no_acl' }
    }
    // Same scoping rationale for the base branch: only where the bare default
    // would otherwise decide. A short-circuit higher up would replace
    // 'allowed_by_acl' with 'base_branch' and silently strip Withdraw rights
    // from ACL-listed users, and would override an explicit 'denied_by_acl'.
    if (options?.isProtectedBranch) {
      return { allowed: true, reason: 'base_branch' }
    }
    return { allowed: false, reason: 'no_acl' }
  }

  const userAllowed = hasUserConstraint && access.allowedUsers?.includes(user.userId)
  const groupAllowed =
    hasGroupConstraint && user.groups?.some((g) => access.allowedGroups?.includes(g))

  const allowed = Boolean(userAllowed || groupAllowed)
  return { allowed, reason: allowed ? 'allowed_by_acl' : 'denied_by_acl' }
}

/**
 * Create a branch access checker with bound default access.
 *
 * `config` is needed to resolve whether a branch is the protected base branch;
 * it routes through `getBranchProtection`, the single source of truth for that
 * question, rather than repeating the base-branch test here.
 */
export function createCheckBranchAccess(
  defaultAccess: DefaultBranchAccess = 'deny',
  config?: Pick<CanopyConfig, 'mode' | 'defaultBaseBranch'>,
) {
  return (context: BranchContext, user: CanopyUser): BranchAccessResult =>
    checkBranchAccessWithDefault(context, user, defaultAccess, {
      isProtectedBranch: config
        ? getBranchProtection(config, context.branch.name, context.branch.baseBranch).isProtected
        : false,
    })
}

/** Options tightening {@link canPerformWorkflowAction} beyond the default hybrid model. */
export interface WorkflowActionOptions {
  /**
   * When true, disables the system-branch grant below. The protected base
   * branch is auto-provisioned with `createdBy: 'canopycms-system'`, which
   * would otherwise let anyone with general branch access submit/withdraw it
   * -- pass `getBranchProtection(...).isProtected` here so only
   * admins/reviewers/explicit-ACL users retain workflow rights on it.
   *
   * It is also forwarded to {@link checkBranchAccessWithDefault}, where the same
   * flag GRANTS access (see {@link BranchAccessOptions.isProtectedBranch}). The
   * two pull in opposite directions on purpose, and that is exactly the intended
   * base-branch posture: readable by anyone the path layer permits, submittable
   * by no one. The access layer says yes, then `isSystemBranch` below is false,
   * so a non-creator/non-ACL/non-privileged user still gets `false` here.
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
 *
 * The creator grant is enforced twice over: `checkBranchAccessWithDefault` now
 * admits the creator (so the gate below no longer swallows them under
 * `defaultBranchAccess: 'deny'`), and `userIsCreator` still decides the result.
 */
export function canPerformWorkflowAction(
  context: BranchContext,
  user: CanopyUser,
  defaultAccess: DefaultBranchAccess = 'deny',
  options?: WorkflowActionOptions,
): boolean {
  // Check if user has general branch access (handles admins, reviewers, creator, ACLs)
  const accessResult = checkBranchAccessWithDefault(context, user, defaultAccess, {
    isProtectedBranch: options?.isProtectedBranch,
  })

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
