import {
  BASE_UPDATE_CLOCK_SKEW_MS,
  BASE_UPDATE_GIVE_UP_MS,
  isBaseUpdatePending,
} from '../base-update'

import type { BranchMetadata, LastBaseUpdate } from '../types'

/**
 * The editor's side of a request for the latest changes (base-update.ts): whether the open
 * branch is waiting on one, how often to poll meanwhile, and what to say. The request and the
 * answer both live on branch.json, so every viewer whose branch list shows the request waits,
 * and a reload keeps waiting.
 */

/**
 * How long the form stays read-only before the wait reads as slow and the form unlocks.
 * @internal Exported for tests.
 */
export const BASE_UPDATE_SLOW_MS = 2 * 60_000
/**
 * The poll while the form is read-only.
 * @internal Exported for tests.
 */
export const BASE_UPDATE_POLL_MS = 3_000
/**
 * The poll once the wait is slow.
 * @internal Exported for tests.
 */
export const BASE_UPDATE_SLOW_POLL_MS = 15_000

/**
 * `waiting`: asked under {@link BASE_UPDATE_SLOW_MS} ago; the form is read-only. `slow`: asked
 * longer ago, under {@link BASE_UPDATE_GIVE_UP_MS}; the form is editable again. `none`: no
 * request is standing, or it is too old to wait on, or the branch left editing, which the worker
 * never brings the base into.
 */
export type BaseUpdateWait = 'none' | 'waiting' | 'slow'

type WaitFields = Pick<BranchMetadata, 'status' | 'baseUpdateRequestedAt' | 'lastBaseUpdate'>

export function baseUpdateWait(branch: WaitFields | undefined, now: number): BaseUpdateWait {
  if (!branch || branch.status !== 'editing' || !isBaseUpdatePending(branch)) return 'none'
  const age = now - Date.parse(branch.baseUpdateRequestedAt ?? '')
  if (!(age < BASE_UPDATE_GIVE_UP_MS) || age < -BASE_UPDATE_CLOCK_SKEW_MS) return 'none'
  return age < BASE_UPDATE_SLOW_MS ? 'waiting' : 'slow'
}

/** When a branch's wait next changes on its own, for a timer to re-render at; undefined for never. */
export function nextBaseUpdateWaitChange(
  branch: WaitFields | undefined,
  now: number,
): number | undefined {
  const wait = baseUpdateWait(branch, now)
  if (wait === 'none') return undefined
  const requestedAt = Date.parse(branch?.baseUpdateRequestedAt ?? '')
  return requestedAt + (wait === 'waiting' ? BASE_UPDATE_SLOW_MS : BASE_UPDATE_GIVE_UP_MS)
}

/** How often the open branch's listing is re-read while it waits; 0 when it doesn't. */
export function baseUpdatePollMs(wait: BaseUpdateWait): number {
  return wait === 'waiting' ? BASE_UPDATE_POLL_MS : wait === 'slow' ? BASE_UPDATE_SLOW_POLL_MS : 0
}

/** @internal Exported for tests. */
export const GET_LATEST_CHANGES_TOOLTIP =
  'Bring in changes made on the site since you started this branch.'

/** The Tooltip; an admin also learns which branch the changes come from. */
export function getLatestChangesTooltip(baseBranch: string | undefined, isAdmin: boolean): string {
  return isAdmin && baseBranch
    ? `${GET_LATEST_CHANGES_TOOLTIP.slice(0, -1)} (from ${baseBranch}).`
    : GET_LATEST_CHANGES_TOOLTIP
}

export const GETTING_LATEST_CHANGES = 'Getting latest changes…'
export const SAVE_FIRST_REASON = 'Save your changes first.'
export const WAITING_NOTICE = 'Getting the latest changes. You can edit again when it finishes.'
export const SLOW_NOTICE =
  'This is taking longer than usual. You can keep editing; the latest changes will come in when the server gets to them.'
/** Why Submit for review waits while the latest changes come in. */
export const WAITING_SUBMIT_REASON = 'Wait for the latest changes to come in.'
/** The waiting notice's addition for a viewer whose unsaved changes it hides meanwhile. */
export const WAITING_DRAFT_NOTE = 'Your unsaved changes come back when it finishes.'
/** When the editor stops waiting on a request the server hasn't answered. */
export const GAVE_UP_MESSAGE =
  'The latest changes haven\'t come in yet. They will when the server gets to them; use "Refresh branch" in the branch menu to see them.'
/** A request the server didn't answer, which may still have gone through. */
export const UNANSWERED_MESSAGE =
  'Your request for the latest changes may have gone through even though the server didn\'t answer. Choose "Refresh branch" in the branch menu to check.'
export const REQUEST_FAILED_MESSAGE = "The latest changes couldn't be requested."

/** The toast an answer gets: its colour, its text, and whether it stays until dismissed. */
export function baseUpdateResultMessage(answer: LastBaseUpdate): {
  color: 'green' | 'yellow' | 'red'
  message: string
  sticky: boolean
} {
  switch (answer.outcome) {
    case 'merged':
      return { color: 'green', message: 'Latest changes added', sticky: false }
    case 'up-to-date':
      return { color: 'green', message: 'You already have the latest changes', sticky: false }
    case 'conflicts': {
      const n = answer.keptEntries
      const entries = !n ? 'Some entries' : n === 1 ? '1 entry' : `${n} entries`
      return {
        color: 'yellow',
        message: `Latest changes added. ${entries} you also changed kept your version; ${n === 1 ? "it's" : "they're"} flagged in the "Content" panel.`,
        sticky: true,
      }
    }
    case 'failed':
      return {
        color: 'red',
        message: "The latest changes couldn't be added. Your work is safe.",
        sticky: true,
      }
  }
}

/** What the bar and the branch card need to offer "Get latest changes" on the open branch. */
export interface BaseUpdateControl {
  wait: BaseUpdateWait
  /** The request itself is in flight. */
  requesting: boolean
  /** Why it can't be asked now. */
  blockedReason?: string
  /** The Tooltip while it can be asked ({@link getLatestChangesTooltip}). */
  tooltip: string
  onRequest: () => void
}
