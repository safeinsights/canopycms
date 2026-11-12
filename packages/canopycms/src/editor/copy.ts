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
  getLatestChanges: 'Get latest changes',
  approve: 'Approve',
  review: 'Review',
  requestChanges: 'Request changes',
  switchBranch: 'Switch branch',
  newBranch: 'New branch',
  archiveBranch: 'Archive branch',
  remove: 'Remove',
  restore: 'Restore',
  clear: 'Clear',
  undoClear: 'Undo clear',
  changeUrl: 'Change URL',
  changeSlug: 'Change slug',
  showChanges: 'Show changes',
  undoChange: 'Undo change',
  redoChange: 'Redo change',
  undoAllChanges: 'Undo all changes',
  redoAllChanges: 'Redo all changes',
  restoreEntry: 'Restore entry',
  deleteEntry: 'Delete entry',
  useLatestVersion: 'Use latest version',
  keepYourVersion: 'Keep your version',
  useBoth: 'Use both',
  markResolved: 'Mark resolved',
  removeIt: 'Remove it',
  keepIt: 'Keep it',
  keepItDeleted: 'Keep it deleted',
  chooseAgain: 'Choose again',
} as const

/** Withdraw's confirm on a branch that conflicts with its base, which then gets the latest changes. */
export const WITHDRAW_AND_GET_LATEST = 'Withdraw and get latest changes'

/**
 * Why a list at its `maxItems` adds nothing more, as a disabled Add's Tooltip or an input's hint.
 * `one` and `many` name what the list holds.
 */
export const listFullReason = (maxItems: number, one = 'item', many = 'items'): string =>
  `This list holds at most ${maxItems} ${maxItems === 1 ? one : many}. Remove one to add another.`

/** Why Submit for review can't act: the worker pushes nothing for a branch rewritten on GitHub. */
export const rewrittenSubmitReason = (isAdmin: boolean): string =>
  isAdmin
    ? 'This branch can\'t be submitted until the changes made to it on GitHub are sorted out. See the "Branches" tab in "System health".'
    : "This branch can't be submitted until an admin sorts out the changes made to it on GitHub."

/**
 * Why Approve can't act: what's approved may not be what the pull request holds. The branch's hold
 * says how to finish the submit, where it can be retried at all.
 */
export const UNFINISHED_SUBMIT_APPROVE_REASON =
  'The last submit didn\'t finish, so this branch can\'t be approved yet. Use "Request changes" to send it back to its editor.'

/** Why an entry's form, and every control that would change the entry, can't act for this user. */
export const NO_EDIT_ACCESS_REASON =
  "You don't have edit access to this entry. Ask a CanopyCMS admin to grant it."

/** Why only an admin may delete a branch that may hold commits nothing else has. */
export const DELETE_NEEDS_ADMIN_REASON =
  'This branch may hold changes that are missing from GitHub. Ask an admin to check it before deleting it.'

/** Why Approve and Request changes can't act: the pull request they act on is gone. */
export const CLOSED_PULL_REQUEST_REASON =
  'The pull request was closed on GitHub. Use "Withdraw from review", then submit it again to open a new one.'
