import type { PullRequestState } from '../types'
import { isReviewer } from './helpers'

/** What the review role depends on in a branch, whichever component holds it. */
export interface ReviewedBranch {
  status: string | undefined
  createdBy: string | undefined
  /** Users on the branch's access list. */
  users?: readonly string[]
  /** Groups on the branch's access list. */
  groups?: readonly string[]
  /** The protected base branch, which is never approved: Withdraw recovers one stuck in review. */
  isProtected?: boolean
  /** A closed pull request cannot be approved or sent back; the way forward is Withdraw. */
  pullRequestState?: PullRequestState
}

/**
 * How `user` relates to `branch`'s review. A reviewer or admin who neither made the branch nor was
 * given access to it by name or by group, on a submitted or approved branch that is not the
 * protected base branch, is `reviewing`: Approve (on a submitted branch) and Request changes
 * lead instead of Withdraw, which stays in the card's "…" menu. With a closed pull request the same user is `reviewing-closed`, since there is
 * nothing to approve and Withdraw is the way forward. Anyone else is `none`.
 */
export type ReviewRole = 'reviewing' | 'reviewing-closed' | 'none'

export function reviewRoleOf(
  branch: ReviewedBranch,
  user: { userId: string; groups?: readonly string[] } | undefined,
): ReviewRole {
  const reviews =
    !!user &&
    isReviewer(user.groups) &&
    !branch.isProtected &&
    (branch.status === 'submitted' || branch.status === 'approved') &&
    branch.createdBy !== user.userId &&
    !branch.users?.includes(user.userId) &&
    !user.groups?.some((g) => branch.groups?.includes(g))
  if (!reviews) return 'none'
  return branch.pullRequestState === 'closed' ? 'reviewing-closed' : 'reviewing'
}

/** Whether `user` reviews `branch`, so its review actions lead; see {@link reviewRoleOf}. */
export const isReviewerOfOthersReview = (
  branch: ReviewedBranch,
  user: { userId: string; groups?: readonly string[] } | undefined,
): boolean => reviewRoleOf(branch, user) === 'reviewing'

/** Longest note a reviewer can attach to a request for changes; the editor's field and the API share it. */
export const REQUEST_CHANGES_NOTE_MAX_LENGTH = 2000
