import type { BranchStatus } from '../types'
import { branchStatusPresentation } from './branch-status'

export interface BranchLockInput {
  branchStatus: BranchStatus | undefined
  /** The protected base branch, read-only in prod. */
  branchReadOnly?: boolean
  branchWriteBlocked?: boolean
  /** The branch list is still being fetched, so details aren't unavailable yet, only pending. */
  branchPending?: boolean
  /** The branch list answered without this branch: no access to it, or it no longer exists. */
  branchMissing?: boolean
}

/**
 * Which lock applies. `branchWriteBlocked` is the server's own answer (getBranchProtection), so
 * nothing offers a write the API would reject; `branchReadOnly` only picks the message, and
 * base-branch read-only takes precedence over a workflow status lock.
 * @internal Exported for tests; the bar reads it through `branchBarStatus`.
 */
export function branchLockState({
  branchStatus,
  branchReadOnly = false,
  branchWriteBlocked = false,
}: BranchLockInput) {
  const statusLocked = branchWriteBlocked && !branchReadOnly
  // `branchStatus` can't describe the lock while branch data loads (undefined) or under version
  // skew (an old server omits `branchWriteBlocked` but reports 'editing'), so both read as
  // unavailable data rather than naming a status the lock contradicts.
  const branchDataUnavailable =
    statusLocked && (branchStatus === undefined || branchStatus === 'editing')
  return { readOnly: branchReadOnly, statusLocked, branchDataUnavailable }
}

/** Why the branch takes no writes, and the way forward, as Save, row locks and the status say. */
export function describeBranchLock(lock: BranchLockInput): string | undefined {
  const { readOnly, statusLocked, branchDataUnavailable } = branchLockState(lock)
  if (readOnly) return 'The base branch is read-only. Create a branch to make changes.'
  if (branchDataUnavailable)
    return lock.branchPending
      ? 'Wait for the branch details to load.'
      : lock.branchMissing
        ? `You don't have access to this branch, or it no longer exists. Use "Switch branch…" to open another.`
        : 'Branch details could not be loaded. Use "Refresh branch" to try again.'
  if (!statusLocked) return undefined
  if (lock.branchStatus === 'submitted')
    return 'This branch is in review. Withdraw it to make changes.'
  if (lock.branchStatus === 'approved')
    return 'This branch is approved. Withdraw it to make changes.'
  return `This branch is ${lock.branchStatus}. Its content is read-only.`
}

export interface BranchBarStatusInput extends BranchLockInput {
  /** The listed branch's `isProtected`, with no fallback here: no listed branch names no protection. */
  isProtected: boolean | undefined
}

export interface BranchBarStatus {
  /** The status element's text; undefined for an editable branch, which shows none. */
  label?: string
  value: string
  readOnly: boolean
  /** The way forward; `workflow` leaves it to the Withdraw control, never offered twice. */
  action?: 'newBranch' | 'switchBranch' | 'refreshBranch' | 'workflow'
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * The branch bar's status and way forward, one row of the lock-state table, checked in order.
 * Pending comes first because a fetch in flight is also `branchDataUnavailable`, and `readOnly`
 * before any status lock, as in `describeBranchLock`.
 */
export function branchBarStatus(input: BranchBarStatusInput): BranchBarStatus {
  const { readOnly, statusLocked, branchDataUnavailable } = branchLockState(input)
  const status = input.branchStatus
  if (input.branchPending) return { label: 'Loading branch…', value: 'loading', readOnly: false }
  if (branchDataUnavailable)
    return input.branchMissing
      ? {
          label: 'Not available · read-only',
          value: 'not-available',
          readOnly: true,
          action: 'switchBranch',
        }
      : {
          label: 'Details unavailable · read-only',
          value: 'unavailable',
          readOnly: true,
          action: 'refreshBranch',
        }
  if (readOnly)
    return {
      label: 'Protected · read-only',
      value: 'protected',
      readOnly: true,
      action: 'newBranch',
    }
  if (!statusLocked)
    return input.isProtected === true
      ? { label: 'Protected', value: 'protected-editable', readOnly: false }
      : { value: 'editable', readOnly: false }
  // A lock with no status is `branchDataUnavailable`, handled above.
  const label = capitalize(branchStatusPresentation(status)?.label ?? String(status))
  return {
    label: `${label} · read-only`,
    value: String(status),
    readOnly: true,
    action: status === 'submitted' || status === 'approved' ? 'workflow' : 'switchBranch',
  }
}
