import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FORM_PANE_ID } from '../shell/PaneLayout'
import type { PreviewReveal } from '../PreviewFrame'
import { PREVIEW_FOLLOW_DELAY_MS, usePreviewFollow } from './usePreviewFollow'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A form pane with two fields and a nested one, plus a control outside the form. */
const Harness = ({
  enabled = true,
  entryKey = 'entry-1',
  onReveal,
  onFollow,
}: {
  enabled?: boolean
  entryKey?: string
  onReveal: (reveal: PreviewReveal | undefined) => void
  onFollow?: (follow: ((path: string) => void) | undefined) => void
}) => {
  const { reveal, follow } = usePreviewFollow({ enabled, entryKey })
  onReveal(reveal)
  onFollow?.(follow)
  return (
    <>
      <div id={FORM_PANE_ID}>
        <div data-canopy-field="title">
          <input aria-label="Title" />
        </div>
        <div data-canopy-field="blocks[0]">
          <div data-canopy-field="blocks[0].heading">
            <input aria-label="Heading" />
          </div>
          <button type="button">Comment on Heading</button>
        </div>
        <input aria-label="No field" />
      </div>
      <input aria-label="Outside" data-canopy-field="title" />
    </>
  )
}

const setup = (props: Partial<React.ComponentProps<typeof Harness>> = {}) => {
  const reveals: Array<PreviewReveal | undefined> = []
  let follow: ((path: string) => void) | undefined
  const onReveal = (reveal: PreviewReveal | undefined) => {
    if (reveals.at(-1) !== reveal) reveals.push(reveal)
  }
  const utils = render(<Harness onReveal={onReveal} onFollow={(f) => (follow = f)} {...props} />)
  const latest = () => reveals.at(-1)
  const sent = () => reveals.filter((r): r is PreviewReveal => r !== undefined)
  const wait = (ms = PREVIEW_FOLLOW_DELAY_MS) => act(() => vi.advanceTimersByTime(ms))
  return { ...utils, latest, sent, wait, follow: () => follow, onReveal }
}

describe('usePreviewFollow', () => {
  it('asks the preview for the field the form rests on, once the delay passes', () => {
    const { getByLabelText, latest, wait } = setup()
    fireEvent.focusIn(getByLabelText('Title'))
    wait(PREVIEW_FOLLOW_DELAY_MS - 1)
    expect(latest()).toBeUndefined()
    wait(1)
    expect(latest()).toEqual({ path: 'title', id: 1 })
  })

  it('sends one reveal for a run of fields tabbed through, for the last', () => {
    const { getByLabelText, getByText, sent, wait } = setup()
    fireEvent.focusIn(getByLabelText('Title'))
    wait(100)
    fireEvent.focusIn(getByLabelText('Heading'))
    wait(100)
    fireEvent.focusIn(getByText('Comment on Heading'))
    wait()
    expect(sent()).toEqual([{ path: 'blocks[0]', id: 1 }])
  })

  it('names the innermost field holding the focus', () => {
    const { getByLabelText, latest, wait } = setup()
    fireEvent.focusIn(getByLabelText('Heading'))
    wait()
    expect(latest()?.path).toBe('blocks[0].heading')
  })

  it('asks again, under a new id, when the form comes back to a field', () => {
    const { getByLabelText, sent, wait } = setup()
    fireEvent.focusIn(getByLabelText('Title'))
    wait()
    fireEvent.focusIn(getByLabelText('Title'))
    wait()
    expect(sent()).toEqual([
      { path: 'title', id: 1 },
      { path: 'title', id: 2 },
    ])
  })

  it('ignores focus outside the form pane, and on no field', () => {
    const { getByLabelText, sent, wait } = setup()
    fireEvent.focusIn(getByLabelText('Outside'))
    fireEvent.focusIn(getByLabelText('No field'))
    wait(1000)
    expect(sent()).toEqual([])
  })

  it('follows a field asked for, as a comment opening on it does, normalizing its path', () => {
    const { follow, latest, wait } = setup()
    act(() => follow()?.('blocks.0.heading'))
    wait()
    expect(latest()).toEqual({ path: 'blocks[0].heading', id: 1 })
  })

  describe('turned off', () => {
    it('sends nothing, and offers no follow', () => {
      const { getByLabelText, sent, wait, follow } = setup({ enabled: false })
      fireEvent.focusIn(getByLabelText('Title'))
      wait(1000)
      expect(sent()).toEqual([])
      expect(follow()).toBeUndefined()
    })

    it('drops a reveal waiting for the delay, and the last one sent', () => {
      const { getByLabelText, latest, wait, rerender, onReveal } = setup()
      fireEvent.focusIn(getByLabelText('Title'))
      wait()
      fireEvent.focusIn(getByLabelText('Heading'))
      rerender(<Harness onReveal={onReveal} enabled={false} />)
      wait(1000)
      expect(latest()).toBeUndefined()
    })
  })

  it('drops the reveal when the entry changes, so another page never gets it', () => {
    const { getByLabelText, latest, wait, rerender, onReveal } = setup()
    fireEvent.focusIn(getByLabelText('Title'))
    wait()
    expect(latest()).toBeDefined()
    fireEvent.focusIn(getByLabelText('Heading'))
    rerender(<Harness onReveal={onReveal} entryKey="entry-2" />)
    wait(1000)
    expect(latest()).toBeUndefined()
  })

  it('stops listening once unmounted', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = setup()
    const added = vi.mocked(remove).mock.calls.length
    unmount()
    expect(remove.mock.calls.slice(added)).toContainEqual(['focusin', expect.any(Function)])
  })
})
