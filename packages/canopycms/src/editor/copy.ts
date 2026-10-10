/**
 * The editor's fixed action verbs, sentence case and verb first. "…" is appended only where
 * the command asks for more before it acts ("Switch branch…"); see docs/ux-guidelines.md.
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
