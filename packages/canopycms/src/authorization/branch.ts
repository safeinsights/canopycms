import type { BranchContext } from '../types'
import type { CanopyConfig, DefaultBranchAccess } from '../config'
import { isAdmin, isLockedOutOfBranch, isReviewer } from './helpers'
import { getBranchProtection } from './protected-branch'
import type { CanopyUser } from '../user'
import type { BranchAccessResult } from './types'
import { isSystemUserId, SYSTEM_USER_ID } from '../system-users'
import { sanitizeBranchName } from '../paths/branch-name'
import { baseBranchOf } from '../utils/base-branch'

/** Options narrowing {@link checkBranchAccessWithDefault} to a specific branch's nature. */
interface BranchAccessOptions {
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
   * callers before authorization runs. What it buys: a public-read
   * `deployedAs: 'server'` site can run 'deny' with
   * `defaultPathAccess: { read: 'allow' }` and still keep un-ACL'd work branches
   * private.
   */
  isProtectedBranch?: boolean
  /**
   * Whether this is dev's auto-provisioned active branch ({@link isDevActiveBranch}). It passes
   * this layer where the base branch does, so it reads (and in dev saves) like the base;
   * {@link canPerformWorkflowAction} never passes it, so no workflow rights follow.
   */
  isDevActiveBranch?: boolean
}

/**
 * Whether `context` is the active branch a dev server provisioned for itself: owned by a CanopyCMS
 * system user, so nobody is its creator, and named like the active branch now, which follows git
 * HEAD unless configured and is not the base when HEAD has left a configured `defaultBaseBranch`.
 * A person's branch never is.
 * `mode` is the adopter's configured operating mode; a prod deployment's is 'prod', so prod
 * returns before the name comparison and never consults its possibly unresolved base branch.
 */
function isDevActiveBranch(
  config: Pick<CanopyConfig, 'mode' | 'defaultBaseBranch' | 'defaultActiveBranch'>,
  context: BranchContext,
): boolean {
  if (config.mode !== 'dev' || !isSystemUserId(context.branch.createdBy)) return false
  const active = config.defaultActiveBranch ?? baseBranchOf(config)
  return sanitizeBranchName(context.branch.name) === sanitizeBranchName(active)
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
 *    would deny, the base branch or dev active branch grant ({@link BranchAccessOptions})
 * @internal Exported for tests.
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
  if (isLockedOutOfBranch(access, user.groups)) {
    return { allowed: false, reason: 'denied_by_acl' }
  }

  const hasUserConstraint = !!access.allowedUsers?.length
  const hasGroupConstraint = !!access.allowedGroups?.length

  if (!hasUserConstraint && !hasGroupConstraint) {
    // The branch creator owns their own un-ACL'd branch, as canDeleteBranch and
    // canModifyBranchAccess also grant: without it, under 'deny' a creator could
    // delete their branch and rewrite its ACL but not read a file on it. Scoped to the no-ACL case on purpose -- an EXPLICIT
    // allowlist omitting the creator still denies them, which is how an admin
    // locks down a branch someone else created.
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
    if (options?.isDevActiveBranch) {
      return { allowed: true, reason: 'dev_active_branch' }
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
 * its single source of truth, rather than repeating the comparison here, and
 * the dev-active-branch question ({@link isDevActiveBranch}).
 */
export function createCheckBranchAccess(
  defaultAccess: DefaultBranchAccess = 'deny',
  config?: Pick<CanopyConfig, 'mode' | 'defaultBaseBranch' | 'defaultActiveBranch'>,
) {
  return (context: BranchContext, user: CanopyUser): BranchAccessResult =>
    checkBranchAccessWithDefault(context, user, defaultAccess, {
      isProtectedBranch: config
        ? getBranchProtection(config, context.branch.name, context.branch.baseBranch).isProtected
        : false,
      isDevActiveBranch: config ? isDevActiveBranch(config, context) : false,
    })
}

/** Options tightening {@link canPerformWorkflowAction} beyond the default hybrid model. */
export interface WorkflowActionOptions {
  /**
   * When true, disables the system-branch grant below. The protected base
   * branch is auto-provisioned with `createdBy: SYSTEM_USER_ID`, which
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

  const isSystemBranch = !options?.isProtectedBranch && context.branch.createdBy === SYSTEM_USER_ID

  return (
    userIsCreator ||
    accessResult.reason === 'privileged' ||
    accessResult.reason === 'allowed_by_acl' ||
    (isSystemBranch && accessResult.allowed)
  )
}
