import { afterEach, describe, expect, it, vi } from 'vitest'

import { hideSeparatorsAtWrap, watchToolbarWrap } from './toolbar-wrap'

/** A toolbar of buttons and separators, each laid out on the row given (0, 1, …). */
const toolbarOf = (items: Array<['button' | 'separator', number]>): HTMLElement => {
  const toolbar = document.createElement('div')
  for (const [kind, row] of items) {
    const el = document.createElement(kind === 'button' ? 'button' : 'div')
    if (kind === 'separator') el.setAttribute('role', 'separator')
    // Separators are shorter than buttons and centred in the row, as MDXEditor draws them.
    const top = row * 32 + (kind === 'separator' ? 8 : 0)
    const height = kind === 'separator' ? 16 : 28
    el.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect
    toolbar.append(el)
  }
  return toolbar
}

const visibility = (toolbar: HTMLElement) =>
  Array.from(toolbar.querySelectorAll<HTMLElement>('[role="separator"]')).map(
    (separator) => separator.style.visibility || 'visible',
  )

describe('hideSeparatorsAtWrap', () => {
  it('keeps a separator between two items on its row', () => {
    const toolbar = toolbarOf([
      ['button', 0],
      ['separator', 0],
      ['button', 0],
    ])
    hideSeparatorsAtWrap(toolbar)
    expect(visibility(toolbar)).toEqual(['visible'])
  })

  it('hides a separator that ends a row and one that starts a row', () => {
    const toolbar = toolbarOf([
      ['button', 0],
      ['separator', 0],
      ['button', 1],
      ['button', 1],
      ['separator', 2],
      ['button', 2],
    ])
    hideSeparatorsAtWrap(toolbar)
    expect(visibility(toolbar)).toEqual(['hidden', 'hidden'])
  })

  it('shows a separator again once the toolbar widens and the row rejoins', () => {
    const toolbar = toolbarOf([
      ['button', 0],
      ['separator', 0],
      ['button', 1],
    ])
    hideSeparatorsAtWrap(toolbar)
    const next = toolbar.lastElementChild as HTMLElement
    next.getBoundingClientRect = () => ({ top: 0, bottom: 28, height: 28 }) as DOMRect
    hideSeparatorsAtWrap(toolbar)
    expect(visibility(toolbar)).toEqual(['visible'])
  })

  it('hides a separator with nothing after it, and leaves one not yet laid out alone', () => {
    const toolbar = toolbarOf([
      ['button', 0],
      ['separator', 0],
    ])
    const unlaid = document.createElement('div')
    unlaid.setAttribute('role', 'separator')
    unlaid.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0 }) as DOMRect
    toolbar.prepend(unlaid)
    hideSeparatorsAtWrap(toolbar)
    expect(visibility(toolbar)).toEqual(['visible', 'hidden'])
  })
})

describe('watchToolbarWrap', () => {
  /** A ResizeObserver whose callback the test fires, recording what it watches. */
  const fakeObserver = () => {
    const state = {
      fire: () => {},
      observed: new Set<Element>(),
      disconnected: false,
    }
    class FakeResizeObserver {
      constructor(callback: () => void) {
        state.fire = callback
      }
      observe(el: Element) {
        state.observed.add(el)
      }
      unobserve(el: Element) {
        state.observed.delete(el)
      }
      disconnect() {
        state.disconnected = true
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    return state
  }

  afterEach(() => vi.unstubAllGlobals())

  const toolbarIn = (root: HTMLElement) => {
    const toolbar = toolbarOf([
      ['button', 0],
      ['separator', 0],
      ['button', 1],
    ])
    toolbar.className = 'tb'
    root.append(toolbar)
    return toolbar
  }

  it('picks up a toolbar that mounts after the root, and a new one after a remount', () => {
    const observer = fakeObserver()
    const root = document.createElement('div')
    const stop = watchToolbarWrap(root, '.tb')
    expect(observer.observed).toEqual(new Set([root]))

    const first = toolbarIn(root)
    observer.fire()
    expect(observer.observed).toEqual(new Set([root, first]))
    expect(visibility(first)).toEqual(['hidden'])

    first.remove()
    const second = toolbarIn(root)
    observer.fire()
    expect(observer.observed).toEqual(new Set([root, second]))
    expect(visibility(second)).toEqual(['hidden'])

    stop()
    expect(observer.disconnected).toBe(true)
  })
})
