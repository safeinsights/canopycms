/**
 * The editor's fixed action verbs, sentence case and verb first. "…" is appended only where
 * the command asks for more before it acts ("Switch branch…"); see docs/ux-guidelines.md.
 * New UI uses these instead of writing the strings inline.
 */
export const EDITOR_ACTIONS = {
  save: 'Save',
  saveAll: 'Save all',
  refreshFromServer: 'Refresh from server',
  submitForReview: 'Submit for review',
  withdrawFromReview: 'Withdraw from review',
  approve: 'Approve',
  review: 'Review',
  requestChanges: 'Request changes',
  switchBranch: 'Switch branch',
  newBranch: 'New branch',
  remove: 'Remove',
  restore: 'Restore',
  clear: 'Clear',
  undoClear: 'Undo clear',
  changeUrl: 'Change URL',
  changeSlug: 'Change slug',
  showChanges: 'Show changes',
} as const

/**
 * Why a list at its `maxItems` adds nothing more, as a disabled Add's Tooltip or an input's hint.
 * `one` and `many` name what the list holds.
 */
export const listFullReason = (maxItems: number, one = 'item', many = 'items'): string =>
  `This list holds at most ${maxItems} ${maxItems === 1 ? one : many}. Remove one to add another.`

/** Why Submit for review can't act: the worker pushes nothing for a branch rewritten on GitHub. */
export const REWRITTEN_SUBMIT_REASON =
  "This branch can't be submitted until an admin sorts out the changes made to it on GitHub."

/** Why Approve and Request changes can't act: the pull request they act on is gone. */
export const CLOSED_PULL_REQUEST_REASON =
  'The pull request was closed on GitHub. Use "Withdraw from review", then submit it again to open a new one.'
