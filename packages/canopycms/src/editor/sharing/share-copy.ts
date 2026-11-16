import type { BranchAddBy } from '../../types'

export const LISTED_ONLY_LINE =
  'Only people listed here can open this branch, plus admins and reviewers.'
export const OPEN_TO_EVERYONE_LINE = 'Anyone who can sign in to the editor can open this branch.'
export const MEMBER_RIGHTS_LINE =
  "People on this list can open, submit and withdraw this branch. What they can read and edit still follows this site's permissions."
export const LOCKDOWN_LINE =
  "This branch is locked to admins and reviewers. People listed here can't open it while it's locked."
export const WIDENING_LINE =
  'Everyone who can sign in will be able to open this branch, and the list will be cleared.'

/** "Who can add people" as the viewer reads it; "Only me" is the owner's own choice. */
export const addByLabel = (addBy: BranchAddBy, viewerIsOwner: boolean): string =>
  addBy === 'members'
    ? 'Anyone on this list'
    : addBy === 'owner'
      ? viewerIsOwner
        ? 'Only me'
        : 'Only the owner'
      : 'Only admins'
