import type { BranchAddBy } from '../../types'

export const LISTED_ONLY_LINE =
  'Only people listed here can open this branch, plus admins and reviewers.'
export const OPEN_TO_EVERYONE_LINE = 'Anyone who can sign in to the editor can open this branch.'
export const MEMBER_RIGHTS_LINE =
  "People on this list can open, submit and withdraw this branch. What they can read and edit still follows this site's permissions."
export const LOCKDOWN_LINE =
  "This branch is locked to admins and reviewers. People listed here can't open it while it's locked."
/** @internal Exported for tests: what opening says with nobody removed. */
export const WIDENING_LINE =
  'Everyone who can sign in will be able to open this branch, and the list will be cleared.'

/** How many people and groups a branch's owner or an admin removed, who stay out when it opens. */
export interface RemovedCount {
  users: number
  groups: number
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "the 1 person removed from this branch", "the 2 people and 1 group …"; '' for nobody. */
export function removedFromBranch(removed: RemovedCount): string {
  const counted = [
    removed.users > 0 && count(removed.users, 'person', 'people'),
    removed.groups > 0 && count(removed.groups, 'group', 'groups'),
  ].filter(Boolean)
  return counted.length > 0 ? `the ${counted.join(' and ')} removed from this branch` : ''
}

/** What opening a branch to everyone does, naming the removed people, who stay out. */
export function wideningLine(removed: RemovedCount): string {
  const except = removedFromBranch(removed)
  return except
    ? `Everyone who can sign in will be able to open this branch, except ${except} (see "Removed"), and the list will be cleared.`
    : WIDENING_LINE
}

/** "Who can add people" as the viewer reads it; "Only me" is the owner's own choice. */
export const addByLabel = (addBy: BranchAddBy, viewerIsOwner: boolean): string =>
  addBy === 'members'
    ? 'Anyone on this list'
    : addBy === 'owner'
      ? viewerIsOwner
        ? 'Only me'
        : 'Only the owner'
      : 'Only admins'
