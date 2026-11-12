/**
 * What the editor says about a branch's open conflicts outside "Show changes": the open entry's
 * notice, Submit's reason, the bar's badge and the "Get latest changes" toast. A count is of the
 * choices left (`MergeConflictsData.openCount`): one per field, and one per entry-level conflict
 * (`openConflictCount`, merge-conflicts.ts). No copy names a
 * branch: an author may not know the branch theirs was cut from.
 */

import type { MergeConflictListItem } from '../api/merge-conflicts'

/** "1 field needs", "2 fields need". */
const fieldsNeed = (count: number): string =>
  count === 1 ? '1 field needs' : `${count} fields need`

const CHOOSE = 'Choose what to keep in "Show changes".'

/** The notice above an entry's form while it has conflicts; the list item when it is loaded. */
export function entryConflictNotice(item: MergeConflictListItem | undefined): string {
  switch (item?.kind) {
    case 'deleted-on-base':
      return `This entry was deleted in the latest version, but you changed it. ${CHOOSE}`
    case 'unreadable':
    case 'deleted-on-branch':
      return `This entry was changed by you and by someone else. ${CHOOSE}`
    case 'fields':
      return `${item.fieldCount === 1 ? '1 field was' : `${item.fieldCount} fields were`} changed by you and by someone else. ${CHOOSE}`
    default:
      return `Some fields were changed by you and by someone else. ${CHOOSE}`
  }
}

/** Why Submit for review waits while choices are open. */
export const conflictsSubmitReason = (count: number): string =>
  `${fieldsNeed(count)} your choice before this branch can be submitted. Choose what to keep in "Show changes" on each flagged entry.`

/** The bar's "Needs action" detail while choices are open. */
export const conflictsHoldMessage = (count: number): string =>
  `${fieldsNeed(count)} your choice: changed by you and by someone else. Choose what to keep in "Show changes" on each flagged entry, then submit.`

/**
 * The "Get latest changes" toast when the merge left choices; undefined: not yet counted. None
 * left is a plain success, which base-update-wait.ts says instead.
 */
export const latestChangesConflictsMessage = (count: number | undefined): string =>
  `Latest changes added. ${count === undefined ? 'Some fields need' : fieldsNeed(count)} your choice.`

/** The bar's "Needs action" detail while the branch's record of conflicts is held. */
export const conflictRecordHeldMessage =
  "This branch's record of conflicts was damaged and set aside, so it's on hold: it can't be submitted or approved until an admin releases the hold."

/** The same, to an admin, who has the way out beside it. */
export const conflictRecordHeldAdminMessage =
  "This branch's record of conflicts was damaged and set aside, so it's on hold: it can't be submitted or approved. Release the hold to let it go on."

/** What "Release hold" gives up, in its confirm. */
export const releaseHoldConsequences =
  "Releasing lets this branch be submitted and approved again. The list of fields that needed a choice is lost for good: each field keeps the value it has now, and no one will be asked to choose. Check the branch's changes first."
