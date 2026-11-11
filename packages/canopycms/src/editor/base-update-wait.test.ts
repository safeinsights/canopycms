import { describe, expect, it } from 'vitest'
import { BASE_UPDATE_GIVE_UP_MS } from '../base-update'
import {
  BASE_UPDATE_POLL_MS,
  BASE_UPDATE_SLOW_MS,
  BASE_UPDATE_SLOW_POLL_MS,
  GET_LATEST_CHANGES_TOOLTIP,
  baseUpdatePollMs,
  baseUpdateResultMessage,
  baseUpdateWait,
  getLatestChangesTooltip,
  nextBaseUpdateWaitChange,
} from './base-update-wait'
import type { BranchStatus, LastBaseUpdate } from '../types'

const ASKED = Date.parse('2026-01-01T00:00:00.000Z')
const asked = (
  over: { status?: BranchStatus; lastBaseUpdate?: LastBaseUpdate; requestedAt?: number } = {},
) => ({
  status: over.status ?? ('editing' as const),
  baseUpdateRequestedAt: new Date(over.requestedAt ?? ASKED).toISOString(),
  lastBaseUpdate: over.lastBaseUpdate,
})

describe('baseUpdateWait', () => {
  it('waits, read-only, until the slow mark, then slow until it gives up', () => {
    expect(baseUpdateWait(asked(), ASKED)).toBe('waiting')
    expect(baseUpdateWait(asked(), ASKED + BASE_UPDATE_SLOW_MS - 1)).toBe('waiting')
    expect(baseUpdateWait(asked(), ASKED + BASE_UPDATE_SLOW_MS)).toBe('slow')
    expect(baseUpdateWait(asked(), ASKED + BASE_UPDATE_GIVE_UP_MS - 1)).toBe('slow')
    expect(baseUpdateWait(asked(), ASKED + BASE_UPDATE_GIVE_UP_MS)).toBe('none')
  })

  it('stops waiting once the answer is at or after the request', () => {
    const answer = (at: number): LastBaseUpdate => ({
      at: new Date(at).toISOString(),
      outcome: 'merged',
    })
    expect(baseUpdateWait(asked({ lastBaseUpdate: answer(ASKED - 1) }), ASKED)).toBe('waiting')
    expect(baseUpdateWait(asked({ lastBaseUpdate: answer(ASKED) }), ASKED)).toBe('none')
  })

  it('never waits on a request stamped beyond clock skew in the future', () => {
    expect(baseUpdateWait(asked({ requestedAt: ASKED + 30_000 }), ASKED)).toBe('waiting')
    expect(baseUpdateWait(asked({ requestedAt: ASKED + 60 * 60_000 }), ASKED)).toBe('none')
  })

  it('never waits on a branch out of editing, nor with no request', () => {
    expect(baseUpdateWait(asked({ status: 'submitted' }), ASKED)).toBe('none')
    expect(baseUpdateWait({ status: 'editing' }, ASKED)).toBe('none')
    expect(baseUpdateWait(undefined, ASKED)).toBe('none')
  })
})

describe('nextBaseUpdateWaitChange', () => {
  it('names the slow mark, then the give-up mark, then nothing', () => {
    expect(nextBaseUpdateWaitChange(asked(), ASKED)).toBe(ASKED + BASE_UPDATE_SLOW_MS)
    expect(nextBaseUpdateWaitChange(asked(), ASKED + BASE_UPDATE_SLOW_MS)).toBe(
      ASKED + BASE_UPDATE_GIVE_UP_MS,
    )
    expect(nextBaseUpdateWaitChange(asked(), ASKED + BASE_UPDATE_GIVE_UP_MS)).toBeUndefined()
  })
})

describe('baseUpdatePollMs', () => {
  it('polls fast while the form is read-only, slower once slow, and not at all otherwise', () => {
    expect(baseUpdatePollMs('waiting')).toBe(BASE_UPDATE_POLL_MS)
    expect(baseUpdatePollMs('slow')).toBe(BASE_UPDATE_SLOW_POLL_MS)
    expect(baseUpdatePollMs('none')).toBe(0)
  })
})

describe('getLatestChangesTooltip', () => {
  it('names the base branch to an admin only', () => {
    expect(getLatestChangesTooltip('main', false)).toBe(GET_LATEST_CHANGES_TOOLTIP)
    expect(getLatestChangesTooltip('main', true)).toBe(
      'Bring in changes made on the site since you started this branch (from main).',
    )
    expect(getLatestChangesTooltip(undefined, true)).toBe(GET_LATEST_CHANGES_TOOLTIP)
  })
})

describe('baseUpdateResultMessage', () => {
  const at = '2026-01-01T00:00:00.000Z'
  it('reports each outcome, keeping the ones that need a look', () => {
    expect(baseUpdateResultMessage({ at, outcome: 'merged' })).toEqual({
      color: 'green',
      message: 'Latest changes added',
      sticky: false,
    })
    expect(baseUpdateResultMessage({ at, outcome: 'up-to-date' }).sticky).toBe(false)
    const kept = baseUpdateResultMessage({ at, outcome: 'conflicts', keptEntries: 2 })
    expect(kept).toMatchObject({ color: 'yellow', sticky: true })
    expect(kept.message).toContain('2 entries')
    expect(baseUpdateResultMessage({ at, outcome: 'conflicts', keptEntries: 1 }).message).toContain(
      '1 entry ',
    )
    expect(baseUpdateResultMessage({ at, outcome: 'conflicts' }).message).toContain('Some entries')
    expect(baseUpdateResultMessage({ at, outcome: 'failed' })).toMatchObject({
      color: 'red',
      sticky: true,
    })
  })
})
