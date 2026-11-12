import { describe, expect, it, vi } from 'vitest'

import { ApiTimeoutError } from '../api/request-deadline'
import { gatewayPage } from './hooks/__test__/test-utils'
import { releaseConflictsHold } from './release-hold'

const client = (release: unknown, list?: unknown) => ({
  conflicts: {
    releaseHold:
      release instanceof Error
        ? vi.fn().mockRejectedValue(release)
        : vi.fn().mockResolvedValue(release),
    list: vi.fn().mockResolvedValue(list),
  },
})
const notHeld = { ok: true, status: 200, data: { conflicts: [], hiddenCount: 0, openCount: 0 } }
const held = { ...notHeld, data: { ...notHeld.data, held: { at: 'x' } } }

describe('releaseConflictsHold', () => {
  it('releases, saying whether the branch was still held', async () => {
    const releasedNow = client({ ok: true, status: 200, data: { released: true } })
    expect(await releaseConflictsHold(releasedNow as never, 'b')).toEqual({
      released: true,
      wasHeld: true,
    })
    const alreadyGone = client({ ok: true, status: 200, data: { released: false } })
    expect(await releaseConflictsHold(alreadyGone as never, 'b')).toEqual({
      released: true,
      wasHeld: false,
    })
  })

  it('says a busy branch in yellow, and another refusal in red', async () => {
    const busy = client({ ok: false, status: 409, error: 'This branch is busy.' })
    expect(await releaseConflictsHold(busy as never, 'b')).toEqual({
      error: 'This branch is busy.',
      tone: 'warning',
    })
    const forbidden = client({ ok: false, status: 403, error: 'Forbidden' })
    expect(await releaseConflictsHold(forbidden as never, 'b')).toEqual({
      error: 'Forbidden',
      tone: 'error',
    })
  })

  it('settles an unanswered request by reading the record again', async () => {
    for (const unanswered of [await gatewayPage(504), new ApiTimeoutError('POST', '/x', 1000)]) {
      // No longer held: released, though this read can't say by whom.
      const landed = client(unanswered, notHeld)
      expect(await releaseConflictsHold(landed as never, 'b')).toEqual({ released: true })
      const stillHeld = client(unanswered, held)
      expect(await releaseConflictsHold(stillHeld as never, 'b')).toMatchObject({
        tone: 'warning',
        error: expect.stringContaining("didn't answer, and the branch is still on hold"),
      })
      const unread = client(unanswered, { ok: false, status: 503, error: 'Busy' })
      expect(await releaseConflictsHold(unread as never, 'b')).toMatchObject({
        tone: 'warning',
        error: expect.stringContaining('may have gone through'),
      })
    }
  })
})
