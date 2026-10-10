import type { BranchStatus } from '../types'

export interface BranchStatusPresentation {
  label: string
  color: string
  variant: 'light' | 'outline'
}

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
