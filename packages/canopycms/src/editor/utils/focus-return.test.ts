import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import { act, render, renderHook } from '@testing-library/react'

import {
  FOCUS_RETURN_ATTR,
  focusIfDropped,
  focusIfIdle,
  focusReturnProps,
  rememberOpener,
  returnTarget,
  useFocusHandOff,
  useStandInOnLeave,
} from './focus-return'

const add = <T extends HTMLElement>(el: T, parent: HTMLElement = document.body): T => {
  parent.appendChild(el)
  return el
}
const button = (parent?: HTMLElement) => add(document.createElement('button'), parent)

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focusIfIdle', () => {
  it('focuses the target when nothing is focused', () => {
    const target = button()
    focusIfIdle(target)
    expect(document.activeElement).toBe(target)
  })

  it('focuses the target while focus is inside an overlay marked as returning focus', () => {
    const overlay = add(document.createElement('div'))
    overlay.setAttribute(FOCUS_RETURN_ATTR, '')
    const inside = button(overlay)
    const target = button()
    inside.focus()

    focusIfIdle(target)

    expect(document.activeElement).toBe(target)
  })

  it('leaves focus where the user moved it', () => {
    const target = button()
    const elsewhere = button()
    elsewhere.focus()

    focusIfIdle(target)

    expect(document.activeElement).toBe(elsewhere)
  })

  it('does not treat a menu or overlay without the marker as idle', () => {
    const overlay = add(document.createElement('div'))
    const inside = button(overlay)
    const target = button()
    inside.focus()

    focusIfIdle(target)

    expect(document.activeElement).toBe(inside)
  })

  it('does nothing without a target', () => {
    const elsewhere = button()
    elsewhere.focus()
    expect(() => focusIfIdle(null)).not.toThrow()
    expect(document.activeElement).toBe(elsewhere)
  })
})

describe('focusIfDropped', () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

  it('focuses the target once focus has dropped to the page, not before', async () => {
    const menu = add(document.createElement('div'))
    const item = button(menu)
    const target = button()
    item.focus()

    focusIfDropped(target)
    expect(document.activeElement).toBe(item)
    item.remove()
    await frame()
    await frame()

    expect(document.activeElement).toBe(target)
  })

  it('leaves focus inside an overlay marked as returning focus, which an item just opened', async () => {
    const overlay = add(document.createElement('div'))
    overlay.setAttribute(FOCUS_RETURN_ATTR, '')
    const inside = button(overlay)
    const target = button()
    inside.focus()

    focusIfDropped(target)
    await frame()
    await frame()

    expect(document.activeElement).toBe(inside)
  })

  it('leaves focus where the user moved it', async () => {
    const target = button()
    const elsewhere = button()
    elsewhere.focus()

    focusIfDropped(target)
    await frame()
    await frame()

    expect(document.activeElement).toBe(elsewhere)
  })

  it('does nothing without a target', async () => {
    focusIfDropped(null)
    await frame()
    await frame()
    expect(document.activeElement).toBe(document.body)
  })
})

describe('rememberOpener', () => {
  it('returns the focused control', () => {
    const opener = button()
    opener.focus()
    expect(rememberOpener()).toBe(opener)
  })

  it('returns null with focus on the page', () => {
    expect(rememberOpener()).toBeNull()
  })

  it('returns null for a menu item, which is gone once it acts', () => {
    const menu = add(document.createElement('div'))
    const item = button(menu)
    item.setAttribute('role', 'menuitem')
    item.focus()
    expect(rememberOpener()).toBeNull()
  })
})

describe('returnTarget', () => {
  it('returns the opener while it is on the page, without asking for the stand-in', () => {
    const opener = button()
    const standIn = vi.fn(() => button())
    expect(returnTarget(opener, standIn)).toBe(opener)
    expect(standIn).not.toHaveBeenCalled()
  })

  it.each([
    ['none was remembered', () => null],
    ['it left the page', () => document.createElement('button')],
  ])('returns the stand-in when %s', (_case, makeOpener) => {
    const standIn = button()
    expect(returnTarget(makeOpener(), () => standIn)).toBe(standIn)
  })
})

describe('focusReturnProps', () => {
  it('is empty without a target, which keeps Mantine returning focus itself', () => {
    expect(focusReturnProps()).toEqual({})
  })

  it('stops Mantine returning focus, marks the overlay and focuses the target on exit', () => {
    const target = button()
    const props = focusReturnProps(() => target)

    expect(props.returnFocus).toBe(false)
    expect(props[FOCUS_RETURN_ATTR]).toBe(true)
    props.onExitTransitionEnd?.()
    expect(document.activeElement).toBe(target)
  })
})

describe('useFocusHandOff', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const button = (name: string) => {
    const el = add(document.createElement('button'))
    el.textContent = name
    return el
  }

  it('moves focus to the control filling the slot the focused one left', () => {
    const { result, rerender } = renderHook(() => useFocusHandOff(2))
    const [[first, second]] = result.current
    const caret = button('Caret')
    const saveAll = button('Save all')
    first(saveAll)
    second(caret)
    caret.focus()
    second(null)
    caret.remove()
    const withdraw = button('Withdraw')
    second(withdraw)
    rerender()
    expect(document.activeElement).toBe(withdraw)
  })

  it('falls back to the first slot filled when the focused control has no counterpart', () => {
    const { result, rerender } = renderHook(() => useFocusHandOff(2))
    const [[first, second]] = result.current
    const saveAll = button('Save all')
    const way = button('Switch branch…')
    first(saveAll)
    second(way)
    way.focus()
    second(null)
    way.remove()
    rerender()
    expect(document.activeElement).toBe(saveAll)
  })

  it('hands nothing off when a ref detaches and re-attaches the same button, as StrictMode does', () => {
    const { result, rerender } = renderHook(() => useFocusHandOff(2))
    const [[first, second]] = result.current
    const saveAll = button('Save all')
    const withdraw = button('Withdraw')
    first(saveAll)
    second(withdraw)
    withdraw.focus()
    second(null)
    second(withdraw)
    // Focus later drops to the page, as a click on its background leaves it.
    withdraw.blur()
    rerender()
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus the user has moved elsewhere', () => {
    const { result, rerender } = renderHook(() => useFocusHandOff(2))
    const [[first, second]] = result.current
    const saveAll = button('Save all')
    const caret = button('Caret')
    first(saveAll)
    second(caret)
    caret.focus()
    second(null)
    const field = button('A form field')
    field.focus()
    caret.remove()
    rerender()
    expect(document.activeElement).toBe(field)
  })
})

describe('useStandInOnLeave', () => {
  /** A control under the hook's ref, keyed by `mode`, and the popover it controls while `open`. */
  function Bar({
    mode,
    open,
    takeover,
    standIn,
  }: {
    mode?: string
    open?: boolean
    takeover?: boolean
    standIn: HTMLElement
  }) {
    const ref = useStandInOnLeave<HTMLButtonElement>(() => standIn)
    if (takeover) return createElement('input', { autoFocus: true, 'aria-label': 'takeover' })
    if (!mode) return null
    return createElement(
      Fragment,
      null,
      createElement(
        'button',
        { key: mode, ref, 'aria-controls': open ? 'who-has-access' : undefined },
        mode,
      ),
      open &&
        createElement('div', { id: 'who-has-access' }, createElement('button', null, 'inside')),
    )
  }
  const named = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)!

  it('hands focus to the stand-in when the focused control leaves', () => {
    const standIn = button()
    const view = render(createElement(Bar, { mode: 'share', standIn }))
    named('share').focus()

    view.rerender(createElement(Bar, { standIn }))

    expect(document.activeElement).toBe(standIn)
  })

  it('leaves focus alone when the control leaves without it', () => {
    const standIn = button()
    const elsewhere = button()
    const view = render(createElement(Bar, { mode: 'share', standIn }))
    elsewhere.focus()

    view.rerender(createElement(Bar, { standIn }))

    expect(document.activeElement).toBe(elsewhere)
  })

  it('leaves focus where something else in the same render took it', () => {
    const standIn = button()
    const view = render(createElement(Bar, { mode: 'share', standIn }))
    named('share').focus()

    view.rerender(createElement(Bar, { takeover: true, standIn }))

    expect(document.activeElement?.getAttribute('aria-label')).toBe('takeover')
  })

  it('keeps focus on the control that replaces it in the same render', () => {
    const standIn = button()
    const view = render(createElement(Bar, { mode: 'share', standIn }))
    named('share').focus()

    view.rerender(createElement(Bar, { mode: 'view', standIn }))

    expect(document.activeElement).toBe(named('view'))
  })

  it('counts focus inside the popover the control opened as the control holding it', () => {
    const standIn = button()
    const view = render(createElement(Bar, { mode: 'view', open: true, standIn }))
    act(() => named('inside').focus())

    view.rerender(createElement(Bar, { standIn }))

    expect(document.activeElement).toBe(standIn)
  })
})
