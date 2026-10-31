import type { BranchHold, BranchStatus } from '../types'
import { escapeForLog } from '../utils/escape-text'

export interface BranchStatusPresentation {
  label: string
  color: string
  variant: 'light' | 'outline'
}

/** @internal Exported for tests. */
export const PROTECTED_BRANCH_PRESENTATION: BranchStatusPresentation = {
  label: 'Protected',
  color: 'neutral',
  variant: 'outline',
}

/** @internal Exported for tests. */
export const BRANCH_STATUS_PRESENTATION: Record<BranchStatus, BranchStatusPresentation> = {
  editing: { label: 'Editing', color: 'brand', variant: 'light' },
  submitted: { label: 'In review', color: 'green', variant: 'light' },
  approved: { label: 'Approved', color: 'teal', variant: 'light' },
  archived: { label: 'Archived', color: 'gray', variant: 'light' },
}

const isKnownStatus = (status: string): status is BranchStatus =>
  Object.prototype.hasOwnProperty.call(BRANCH_STATUS_PRESENTATION, status)

/**
 * The badge for a branch: the protected base branch reads "Protected" whatever its workflow
 * status, so a base branch never advertises a state it cannot act on. `status` is a string
 * because server data is untyped at runtime; an unrecognised one shows as itself, neutrally.
 * Returns undefined when there is nothing to show.
 */
export function branchStatusPresentation(
  status: string | undefined,
  isProtected = false,
): BranchStatusPresentation | undefined {
  if (isProtected) return PROTECTED_BRANCH_PRESENTATION
  if (!status) return undefined
  if (isKnownStatus(status)) return BRANCH_STATUS_PRESENTATION[status]
  return { label: status, color: 'gray', variant: 'light' }
}

/** The badge for a branch something holds, in the bar, on the card and in System health. */
export const HOLD_BADGE = { label: 'Needs action', color: 'yellow' } as const

/** Who is reading a hold, which decides the way forward it can offer them. */
export interface HoldViewer {
  /** `withdraw`: may withdraw it. `review`: reviews someone else's. `none`: can do neither. */
  role: 'withdraw' | 'review' | 'none'
  isAdmin: boolean
  /** Reading it in System health, which can't send an admin to itself. */
  inSystemHealth?: boolean
}

/**
 * What's stuck and what this viewer can do about it. A retargeted base comes from GitHub and is
 * attacker-chosen, so it's shown escaped.
 */
export function branchHoldMessage(hold: BranchHold, viewer: HoldViewer): string {
  switch (hold.kind) {
    case 'conflicts': {
      const stuck =
        "This branch conflicts with its base branch, so its pull request can't be updated."
      if (viewer.role === 'review')
        return `${stuck} Use "Request changes" to send it back to its editor.`
      if (viewer.role === 'none') return `${stuck} Its editor needs to withdraw it from review.`
      return `${stuck} Use "Withdraw from review", check any flagged entries, then submit it again.`
    }
    case 'retargeted':
      return `This pull request now merges into ${escapeForLog(hold.base)} on GitHub, so CanopyCMS isn't updating it. Update it on the pull request${viewer.isAdmin ? '' : ', or ask an admin'}.`
    case 'rewritten': {
      const stuck =
        "This branch was changed on GitHub in a way CanopyCMS can't combine with the work here, so changes here can't reach GitHub. Nothing is lost."
      if (viewer.inSystemHealth)
        return `${stuck} A developer needs to merge the missing commit back into the branch on GitHub. The "Rebase failing" warning icon in this row names it.`
      return viewer.isAdmin
        ? `${stuck} See the "Branches" tab in "System health".`
        : `${stuck} Ask an admin for help.`
    }
    case 'submit-unfinished': {
      const stuck = hold.opened
        ? "The last submit of this branch didn't finish, so its pull request may not have its latest changes."
        : "The last submit of this branch didn't finish, so its pull request wasn't opened."
      if (hold.notQueued) {
        if (viewer.role === 'review')
          return `${stuck} Use "Request changes" to send it back to its editor.`
        return viewer.role === 'withdraw'
          ? `${stuck} Use "Withdraw from review", then submit the branch again.`
          : `${stuck} Its editor needs to withdraw it from review and submit it again.`
      }
      const retry = viewer.inSystemHealth
        ? 'Retry the submit from the "Tasks" tab'
        : viewer.isAdmin
          ? 'Retry the submit from the "Tasks" tab in "System health"'
          : 'Ask an admin to retry the submit'
      const instead =
        viewer.role === 'withdraw'
          ? ', or use "Withdraw from review", then submit the branch again'
          : viewer.role === 'review'
            ? ', or use "Request changes" to send it back to its editor'
            : ''
      return `${stuck} ${retry}${instead}.`
    }
    case 'unpublished-at-merge': {
      const stuck =
        'This pull request merged before the last submit finished, so some changes may not be in the merge.'
      if (viewer.inSystemHealth) return `${stuck} The "Overview" tab says what to do.`
      return viewer.isAdmin
        ? `${stuck} See the "Overview" tab in "System health".`
        : `${stuck} Ask an admin to check it.`
    }
  }
}

/** Ends `text` as a sentence, for a recorded reason that another sentence follows. */
export function endSentence(text: string): string {
  const trimmed = text.trimEnd()
  return /[.!?:][)"']*$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** Why a branch in review with a failed sync stays behind its base, after the failure itself. */
export const SYNC_FAILED_IN_REVIEW_NOTE =
  "Until it syncs, CanopyCMS won't update this pull request from its base."

/** The failed-sync line when the worker recorded no reason. An archived branch has nothing to retry. */
export const syncFailedFallback = (isAdmin: boolean, status?: string): string => {
  if (status === 'archived') return 'GitHub sync failed.'
  return isAdmin
    ? 'GitHub sync failed. Retry it from the "Tasks" tab in "System health".'
    : 'GitHub sync failed. Ask an admin to retry it.'
}
