import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifications } from '@mantine/notifications'
import { useTrackedWrites } from './use-tracked-writes'
import { MayHaveLandedError } from '../unanswered'

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

afterEach(() => vi.clearAllMocks())

describe('useTrackedWrites', () => {
  it.each([
    ['red', new Error('Not added')],
    ['yellow', new MayHaveLandedError('May have been posted')],
  ])('toasts a write that fails after unmount in %s', async (color, err) => {
    let fail: (e: Error) => void = () => {}
    const { result, unmount } = renderHook(() => useTrackedWrites())
    const write = result.current.track(() => new Promise<void>((_, reject) => (fail = reject)))
    let pending!: Promise<void>
    act(() => {
      pending = write()
    })
    unmount()

    fail(err)
    await expect(pending).rejects.toBe(err)

    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ color, message: err.message }),
    )
  })
})
