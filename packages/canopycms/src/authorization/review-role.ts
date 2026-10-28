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
 * Whether `user` reviews `branch` rather than owns it: a reviewer or admin, with the branch
 * submitted or approved not the protected base branch and with no closed pull request, who neither made it nor was given access by name or by group. Such a
 * user is offered Approve and Request changes in place of Withdraw.
 */
export function isReviewerOfOthersReview(
  branch: ReviewedBranch,
  user: { userId: string; groups?: readonly string[] } | undefined,
): boolean {
  return (
    !!user &&
    isReviewer(user.groups) &&
    !branch.isProtected &&
    branch.pullRequestState !== 'closed' &&
    (branch.status === 'submitted' || branch.status === 'approved') &&
    branch.createdBy !== user.userId &&
    !branch.users?.includes(user.userId) &&
    !user.groups?.some((g) => branch.groups?.includes(g))
  )
}

/** Longest note a reviewer can attach to a request for changes; the editor's field and the API share it. */
export const REQUEST_CHANGES_NOTE_MAX_LENGTH = 2000
