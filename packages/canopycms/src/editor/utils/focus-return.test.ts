import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FOCUS_RETURN_ATTR,
  focusIfDropped,
  focusIfIdle,
  focusReturnProps,
  rememberOpener,
  returnTarget,
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
