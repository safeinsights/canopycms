/**
 * The editor's fixed action verbs. Sentence case, verb first, and no trailing ellipsis:
 * "…" marks an in-progress state ("Saving…"), never a button that opens a dialog.
 * New UI uses these instead of writing the strings inline.
 */
export const EDITOR_ACTIONS = {
  save: 'Save',
  submitForReview: 'Submit for review',
  withdrawFromReview: 'Withdraw from review',
  requestChanges: 'Request changes',
  switchBranch: 'Switch branch',
  newBranch: 'New branch',
  remove: 'Remove',
} as const
