import type { LogicalPath } from '../../paths/types'
import type { ApiErrorCode } from '../../api/types'
import { ENTRY_CHANGED_MESSAGE } from '../../api/entries-constants'
import { SCHEMA_UNAVAILABLE_CODE } from '../unavailable-entry-type'
import { isUnanswered } from '../unanswered'
import { EDITOR_ACTIONS } from '../copy'
import { SaveApiError } from './useEntryManager'

/**
 * Why one entry of a Save all was not saved. `unanswered` and `conflict` lose nothing yet, so
 * they warn (yellow); the rest are errors (red).
 */
export type SaveAllFailureKind = 'unanswered' | 'conflict' | 'invalid' | 'blocked' | 'error'

export interface SaveAllFailure {
  contentId: string
  label: string
  path: LogicalPath
  kind: SaveAllFailureKind
  /** A full sentence for the result's list, after the entry's name. */
  reason: string
  /** "Save as new entry", for an entry deleted since its edits started. */
  recreate?: () => void
}

export interface SaveAllResult {
  branch: string
  /** The entries Save all set out to save. */
  total: number
  saved: Array<{ contentId: string; label: string; path: LogicalPath }>
  failed: SaveAllFailure[]
}

export interface SaveAllProgress {
  /** Entries settled so far, saved or not. */
  done: number
  total: number
}

/** One result toast at a time: a new run replaces it, and a branch switch takes it down. */
export const SAVE_ALL_RESULT_TOAST_ID = 'canopy-save-all-result'

const ENTRY_GONE_CODE = 'ENTRY_GONE' satisfies ApiErrorCode

export const SAVE_ALL_REASONS = {
  unanswered: `Saving it may have gone through even though the server didn't answer. Open it and choose "${EDITOR_ACTIONS.refreshFromServer}" to check before saving again.`,
  earlierUnanswered: `An earlier save of it may have gone through even though the server didn't answer. Open it and choose "${EDITOR_ACTIONS.refreshFromServer}" to check before saving again.`,
  staleBase: `It changed on the server since your edits started, so saving would overwrite someone else's changes. Open it and choose "${EDITOR_ACTIONS.refreshFromServer}" to see the latest version (your unsaved edits will be lost).`,
  unknownBase:
    'Its unsaved changes come from an older version of the editor. Open it and save it on its own to confirm the overwrite.',
  unavailable: "Its entry type isn't available in this version of the site, so it can't be saved.",
  noEditAccess: "You don't have edit access to it.",
  loadFailed: "It couldn't be loaded from the server, so it wasn't saved. Try Save all again.",
  renamed:
    "It was renamed since your edits started, so it wasn't saved. Your changes moved with it: save again.",
  deleted:
    'It was deleted since your edits started, so it wasn\'t saved. Choose "Save as new entry" to keep your changes.',
  goneUnchecked:
    "It was deleted or renamed since your edits started, so it wasn't saved, and the editor couldn't check which. Reload the page: if it was renamed, your changes moved with it.",
  failed: 'Save failed. Try again.',
} as const

export const invalidReason = (count: number): string =>
  `${count} ${count === 1 ? 'field needs' : 'fields need'} fixing. Open it to see which.`

/**
 * Classifies a refused or unanswered save the way `handleSave` does, minus its toasts: Save all
 * reports every entry in one result. `ENTRY_GONE`, a may-have-landed 409 and an unanswered write
 * need the caller's follow-up, so they come back as `gone`, `landed?` and `unanswered`.
 */
export function classifySaveAllError(
  err: unknown,
  retryOfUnanswered: boolean,
):
  | { kind: 'gone' }
  | { kind: 'landed?' }
  | { kind: 'unanswered' }
  | { kind: Exclude<SaveAllFailureKind, 'unanswered'>; reason: string; fieldErrors?: boolean } {
  if (isUnanswered(err)) return { kind: 'unanswered' }
  if (!(err instanceof SaveApiError)) return { kind: 'error', reason: SAVE_ALL_REASONS.failed }
  if (err.status === 409) {
    if (err.code === ENTRY_GONE_CODE) return { kind: 'gone' }
    // The retry of a save that got no answer, refused as changed, most likely bounced off itself.
    if (
      err.code === 'WRITE_OUTCOME_UNKNOWN' ||
      (retryOfUnanswered && err.serverMessage === ENTRY_CHANGED_MESSAGE)
    ) {
      return { kind: 'landed?' }
    }
    // The version check's own wording names the single-entry recovery, so Save all says it its way.
    const changed = !err.serverMessage || err.serverMessage === ENTRY_CHANGED_MESSAGE
    return { kind: 'conflict', reason: changed ? SAVE_ALL_REASONS.staleBase : err.serverMessage }
  }
  if (err.code === SCHEMA_UNAVAILABLE_CODE) return { kind: 'blocked', reason: err.message }
  if (err.status === 422) {
    return { kind: 'invalid', reason: err.message, fieldErrors: !!err.fieldErrors?.length }
  }
  if (err.status === 403) return { kind: 'blocked', reason: err.message }
  return { kind: 'error', reason: SAVE_ALL_REASONS.failed }
}
