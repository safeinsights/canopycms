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
   * `getBranchProtection(...).isProtected`. When true the branch passes this
   * layer wherever no explicit ACL decided the question, leaving the PATH layer
   * to decide what is readable; explicit ACL verdicts still win in both
   * directions (see the fallback site below).
   *
   * The grant is load-bearing: the base branch takes no ACL
   * (`updateBranchAccessHandler` rejects one, since an entry there would feed
   * `allowed_by_acl` and confer Withdraw rights) and its `createdBy` is
   * `canopycms-system`, so nobody is its creator -- without this it is
   * unreachable under `defaultBranchAccess: 'deny'` with no way to configure
   * around it. It widens nothing dangerous: {@link canPerformWorkflowAction}
   * disables its system-branch grant on the same flag, prod writes stay blocked
   * by `getBranchWriteProtection().readOnly`, and the editor API 401s anonymous
   * callers before authorization runs.
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
    // The branch creator owns their own un-ACL'd branch, matching the three
    // places that already grant on creator-ownership independently of branch
    // access (listBranchesHandler, canDeleteBranch, canModifyBranchAccess):
    // without it, under 'deny' a creator could delete their branch and rewrite
    // its ACL but not read a file on it. Scoped to the no-ACL case on purpose --
    // an EXPLICIT allowlist omitting the creator still denies them, which is how
    // an admin locks down a branch someone else created.
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
 * Bind a default access level. `config` is needed only to resolve the
 * protected-base-branch question, which routes through `getBranchProtection`,
 * its single source of truth, rather than repeating the comparison here.
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
   * The same flag GRANTS access in {@link checkBranchAccessWithDefault} (see
   * {@link BranchAccessOptions.isProtectedBranch}); pulling in opposite
   * directions is the intended base-branch posture -- readable by anyone the
   * path layer permits, submittable by no one.
   */
  isProtectedBranch?: boolean
}

/**
 * Whether a user may submit/withdraw a branch: creator, OR ACL access, OR a
 * system branch plus general access.
 *
 * The creator grant is enforced twice: `checkBranchAccessWithDefault` admits
 * the creator, so the gate below cannot swallow them under
 * `defaultBranchAccess: 'deny'`, and `userIsCreator` decides the result.
 */
export function canPerformWorkflowAction(
  context: BranchContext,
  user: CanopyUser,
  defaultAccess: DefaultBranchAccess = 'deny',
  options?: WorkflowActionOptions,
): boolean {
  const accessResult = checkBranchAccessWithDefault(context, user, defaultAccess, {
    isProtectedBranch: options?.isProtectedBranch,
  })

  if (!accessResult.allowed) {
    return false
  }

  const userIsCreator = context.branch.createdBy === user.userId

  const isSystemBranch =
    !options?.isProtectedBranch && context.branch.createdBy === 'canopycms-system'

  return (
    userIsCreator ||
    accessResult.reason === 'privileged' ||
    accessResult.reason === 'allowed_by_acl' ||
    (isSystemBranch && accessResult.allowed)
  )
}
