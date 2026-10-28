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
