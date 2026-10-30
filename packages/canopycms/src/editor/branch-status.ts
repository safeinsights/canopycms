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

/**
 * What's stuck and what to do about it, for anyone viewing the branch. A retargeted base comes
 * from GitHub and is attacker-chosen, so it's shown escaped.
 */
export function branchHoldMessage(hold: BranchHold): string {
  switch (hold.kind) {
    case 'conflicts':
      return "This branch conflicts with its base branch, so its pull request can't be updated. Withdraw it from review to resolve the conflict."
    case 'retargeted':
      return `This pull request now targets ${escapeForLog(hold.base)} on GitHub, so CanopyCMS isn't updating it. Use Update branch on GitHub.`
    case 'rewritten':
      return "This branch was force-pushed on GitHub, so changes here can't reach it. A developer can fix this: System health says how."
  }
}

/** Why a branch in review with a failed sync stays behind its base, after the failure itself. */
export const SYNC_FAILED_IN_REVIEW_NOTE =
  "CanopyCMS won't update this pull request from its base until the sync is fixed."
