import type { ApiErrorCode } from '../api/types'

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
  releaseHold: 'Release hold',
  removeIt: 'Remove it',
  keepIt: 'Keep it',
  keepItDeleted: 'Keep it deleted',
  chooseAgain: 'Choose again',
  share: 'Share',
  updateAccess: 'Update access',
  copyLink: 'Copy link',
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

/** What a refusal to open a branch, to create one or to change who may open one tells the person refused. */
const ACCESS_REFUSALS: Partial<Record<ApiErrorCode, string>> = {
  BRANCH_CREATE_FORBIDDEN:
    "You can't create branches, because you don't have edit access to any content here. Ask a CanopyCMS admin to grant it.",
  BRANCH_ACCESS_DENIED:
    'You no longer have access to this branch. Choose another branch in "Branches".',
  BRANCH_LOCKED_DOWN: 'An admin has limited this branch to admins and reviewers.',
  BRANCH_ARCHIVED: "This branch is archived, so who has access can't change.",
  BRANCH_NOT_SHAREABLE: 'Only an admin can share this branch.',
  ACCESS_ADD_FORBIDDEN: 'You can no longer add people to this branch.',
  ACCESS_MANAGE_FORBIDDEN: "Only this branch's owner or an admin can make that change.",
  ACCESS_CHANGE_INVALID:
    'These changes can\'t be made together. Choose "Discard changes", then open "Share…" again.',
  EXCLUSION_CAP:
    'Too many people and groups have been removed from this branch. Allow some back first.',
  LIST_CHANGED: 'The list changed while this was being saved. Try again.',
  USER_NOT_FOUND: "Some of the people you added couldn't be found. Remove them and try again.",
  USER_OUT_OF_SCOPE:
    "Some of the people you added don't work in this editor. Add them by their full email address instead.",
  USER_EXCLUDED:
    'Someone you added was removed from this branch, and only its owner or an admin can allow them back.',
  GROUP_EXCLUDED:
    'A group you added was removed from this branch, and only its owner or an admin can allow it back.',
  GROUP_NOT_YOURS: 'You can add only groups you belong to.',
  RESERVED_GROUP: 'Admins and reviewers already have access.',
  OPEN_NOT_ALLOWED: 'Branches on this site are open only to the people listed.',
  RATE_LIMITED: 'Too many email lookups. Try again in a few minutes.',
}

/** An owner is refused these only for an admin's removal, which an owner can't lift. */
const OWNER_ACCESS_REFUSALS: Partial<Record<ApiErrorCode, string>> = {
  USER_EXCLUDED:
    'Someone you added was removed from this branch by an admin, and only an admin can allow them back.',
  GROUP_EXCLUDED:
    'A group you added was removed from this branch by an admin, and only an admin can allow it back.',
}

/**
 * The sentence for an access refusal's `code`, or undefined for any other answer; `viewerIsOwner`
 * for the branch's owner.
 */
export const accessRefusalMessage = (
  code: ApiErrorCode | undefined,
  viewerIsOwner = false,
): string | undefined =>
  code ? (viewerIsOwner && OWNER_ACCESS_REFUSALS[code]) || ACCESS_REFUSALS[code] : undefined
