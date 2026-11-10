import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CANOPY_PREVIEW_READY,
  CANOPY_PREVIEW_REVEAL,
  MARK_REPORT_LIMITS,
  findRevealTargets,
  useCanopyPreview,
  usePreviewReveal,
} from './preview-bridge'
import { PreviewFrame } from './PreviewFrame'

/** Runs the page inside an editor frame: window.parent is a separate jsdom window. */
const simulateFramed = () => {
  const host = document.createElement('iframe')
  document.body.appendChild(host)
  const parentWin = host.contentWindow as Window
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parentWin })
  vi.spyOn(parentWin, 'postMessage').mockImplementation(() => {})
  return parentWin
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Object.defineProperty(window, 'parent', { configurable: true, get: () => window })
  document.querySelectorAll('iframe').forEach((el) => el.remove())
  document.getElementById('canopycms-preview-reveal-style')?.remove()
  vi.restoreAllMocks()
})

/** Lays an element out at `top`, `height` pixels tall, in a 768px-high viewport. */
const place = (element: HTMLElement, top: number, height = 40) => {
  const rect = DOMRect.fromRect({ x: 10, y: top, width: 300, height })
  element.getBoundingClientRect = () => rect
  element.getClientRects = () => [rect] as unknown as DOMRectList
  const scroll = vi.fn()
  element.scrollIntoView = scroll
  return scroll
}

const Page = ({ children, editorOrigin }: { children: React.ReactNode; editorOrigin?: string }) => {
  usePreviewReveal({ editorOrigin })
  return <>{children}</>
}

const marked = (testId: string, path: string) => (
  <div data-testid={testId} data-canopy-path={path} />
)

const send = (data: unknown, parentWin: Window, origin = window.location.origin) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: parentWin }))
  })

const reveal = (path: unknown) => ({ type: CANOPY_PREVIEW_REVEAL, path })

const renderPage = (children: React.ReactNode, editorOrigin?: string) => {
  const parentWin = simulateFramed()
  const utils = render(<Page editorOrigin={editorOrigin}>{children}</Page>)
  return { ...utils, parentWin }
}

describe('a reveal from the editor', () => {
  it('scrolls the element marked for the path to the middle of the page and marks it briefly', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('title', 'title')}
        {marked('hero', 'blocks[0].heading')}
      </>,
    )
    place(getByTestId('title'), 10)
    const scroll = place(getByTestId('hero'), 2000)

    send(reveal('blocks[0].heading'), parentWin)

    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    expect(getByTestId('hero').hasAttribute('data-canopy-revealed')).toBe(true)
    // The mark's time starts once the page's scrolling pauses for 150 ms.
    for (let ms = 0; ms < 800; ms += 100) {
      act(() => {
        document.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(100)
      })
    }
    // The last scroll was 100 ms ago, so the pause completes 50 ms on.
    act(() => vi.advanceTimersByTime(50 + 1499))
    expect(getByTestId('hero').hasAttribute('data-canopy-revealed')).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(getByTestId('hero').hasAttribute('data-canopy-revealed')).toBe(false)
  })

  it('times the mark from the scrolling that holds it, not another scroller on the page', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        <div data-testid="carousel" />
        {marked('a', 'a')}
      </>,
    )
    place(getByTestId('a'), 2000)
    send(reveal('a'), parentWin)
    for (let ms = 0; ms < 1600; ms += 100) {
      act(() => {
        getByTestId('carousel').dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(100)
      })
    }
    act(() => vi.advanceTimersByTime(100))
    expect(getByTestId('a').hasAttribute('data-canopy-revealed')).toBe(false)
  })

  it('starts the mark time after 3 s of scrolling that never pauses', () => {
    const { getByTestId, parentWin } = renderPage(marked('a', 'a'))
    place(getByTestId('a'), 2000)
    send(reveal('a'), parentWin)
    for (let ms = 0; ms < 3000 + 1499; ms += 100) {
      act(() => {
        document.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(100)
      })
    }
    act(() => vi.advanceTimersByTime(1))
    expect(getByTestId('a').hasAttribute('data-canopy-revealed')).toBe(false)
  })

  it('judges a reveal sent mid-scroll by where the page is going, not where it is passing', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('far', 'far')}
        {marked('mid', 'mid')}
      </>,
    )
    place(getByTestId('far'), 5000)
    const midScroll = place(getByTestId('mid'), 300)
    send(reveal('far'), parentWin)
    act(() => vi.advanceTimersByTime(100))
    send(reveal('mid'), parentWin)
    expect(midScroll).toHaveBeenCalledTimes(1)
    expect(getByTestId('far').hasAttribute('data-canopy-revealed')).toBe(false)
    expect(getByTestId('mid').hasAttribute('data-canopy-revealed')).toBe(true)
  })

  it("adds its white ring to the element's own shadow, and gives it back", () => {
    const { getByTestId, parentWin } = renderPage(marked('a', 'a'))
    const element = getByTestId('a')
    element.style.boxShadow = 'inset 0 0 0 2px black'
    place(element, 2000)
    send(reveal('a'), parentWin)
    expect(element.style.boxShadow).toContain('0 0 0 9px')
    expect(element.style.boxShadow).toContain('inset 0 0 0 2px black')
    act(() => vi.advanceTimersByTime(150 + 1500))
    expect(element.style.boxShadow).toBe('inset 0 0 0 2px black')
  })

  it('outlines the mark whether or not highlighting is on', () => {
    const { parentWin } = renderPage(marked('a', 'a'))
    send(reveal('a'), parentWin)
    const style = document.getElementById('canopycms-preview-reveal-style')
    expect(style?.textContent).toContain('outline')
  })

  it('outranks the highlight outline, which the page may add after it, by matching two attributes', () => {
    const { parentWin } = renderPage(marked('a', 'a'))
    send(reveal('a'), parentWin)
    const sheet = (document.getElementById('canopycms-preview-reveal-style') as HTMLStyleElement)
      .sheet as CSSStyleSheet
    expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe(
      '[data-canopy-path][data-canopy-revealed]',
    )
  })

  it('matches a mark spelled with dots to a path spelled with brackets', () => {
    const { getByTestId, parentWin } = renderPage(marked('item', 'items.2.label'))
    const scroll = place(getByTestId('item'), 1500)
    send(reveal('items[2].label'), parentWin)
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('prefers the marks inside a list item to a mark for the whole list', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('list', 'features')}
        {marked('item', 'features[7].title')}
      </>,
    )
    const listScroll = place(getByTestId('list'), 900, 3000)
    const itemScroll = place(getByTestId('item'), 1400)
    send(reveal('features[7]'), parentWin)
    expect(itemScroll).toHaveBeenCalledTimes(1)
    expect(listScroll).not.toHaveBeenCalled()
  })

  it.each([
    ['below', 2500],
    ['above', -2800],
  ])('scrolls to a mark flush with a clipping box %s the page', (_, boxTop) => {
    const { getByTestId, parentWin } = renderPage(
      <div data-testid="card" style={{ overflow: 'hidden' }}>
        {marked('image', 'card.image')}
      </div>,
    )
    getByTestId('card').getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: boxTop, width: 400, height: 300 })
    const scroll = place(getByTestId('image'), boxTop, 200)
    send(reveal('card.image'), parentWin)
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('falls back to the nearest marked ancestor: the list item, then the block', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('block', 'blocks[1]')}
        {marked('item', 'blocks[1].items[3]')}
      </>,
    )
    const blockScroll = place(getByTestId('block'), 1200, 600)
    const itemScroll = place(getByTestId('item'), 1500)

    send(reveal('blocks[1].items[3].label'), parentWin)
    expect(itemScroll).toHaveBeenCalledTimes(1)
    expect(blockScroll).not.toHaveBeenCalled()

    send(reveal('blocks[1].caption'), parentWin)
    expect(blockScroll).toHaveBeenCalledTimes(1)
  })

  it('falls back to the marks inside a field that has none of its own, first in the page first', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('other', 'tagline')}
        {marked('first', 'tags[0]')}
        {marked('second', 'tags[1]')}
        {marked('nested', 'hero.title')}
      </>,
    )
    place(getByTestId('other'), 3000)
    const firstScroll = place(getByTestId('first'), 1500)
    const secondScroll = place(getByTestId('second'), 1600)
    const nestedScroll = place(getByTestId('nested'), 1700)
    send(reveal('tags'), parentWin)
    expect(firstScroll).toHaveBeenCalledTimes(1)
    expect(secondScroll).not.toHaveBeenCalled()
    send(reveal('hero'), parentWin)
    expect(nestedScroll).toHaveBeenCalledTimes(1)
  })

  it('leaves a mark taller than the page that fills it, as one being read', () => {
    const { getByTestId, parentWin } = renderPage(marked('body', 'body'))
    const scroll = place(getByTestId('body'), -1500, 3000)
    send(reveal('body'), parentWin)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('leaves a mark wider than the page that fills its width and shows its height', () => {
    const { getByTestId, parentWin } = renderPage(marked('table', 'table'))
    const table = getByTestId('table')
    const rect = DOMRect.fromRect({ x: -100, y: 150, width: window.innerWidth + 300, height: 200 })
    table.getBoundingClientRect = () => rect
    table.getClientRects = () => [rect] as unknown as DOMRectList
    const scroll = vi.fn()
    table.scrollIntoView = scroll
    send(reveal('table'), parentWin)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('scrolls a mark its scrolling box cuts off, though the window would show it', () => {
    const { getByTestId, parentWin } = renderPage(
      <div data-testid="box" style={{ overflow: 'auto' }}>
        {marked('deep', 'deep')}
      </div>,
    )
    getByTestId('box').getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 100, width: 400, height: 150 })
    const scroll = place(getByTestId('deep'), 450)
    send(reveal('deep'), parentWin)
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('shows the top of a mark taller than the page', () => {
    const { getByTestId, parentWin } = renderPage(marked('body', 'body'))
    const scroll = place(getByTestId('body'), 900, 3000)
    send(reveal('body'), parentWin)
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }))
  })

  it("jumps, whatever the page's own scroll-behavior, when the reader asks for reduced motion", () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduce'), media: query }) as MediaQueryList,
    )
    const { getByTestId, parentWin } = renderPage(marked('a', 'a'))
    const scroll = place(getByTestId('a'), 2000)
    send(reveal('a'), parentWin)
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }))
    act(() => vi.advanceTimersByTime(1500))
    expect(getByTestId('a').hasAttribute('data-canopy-revealed')).toBe(false)
  })

  it('does nothing when a mark for the path is already in full view', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('below', 'title')}
        {marked('above', 'title')}
      </>,
    )
    const belowScroll = place(getByTestId('below'), 2000)
    const aboveScroll = place(getByTestId('above'), 100)
    send(reveal('title'), parentWin)
    expect(belowScroll).not.toHaveBeenCalled()
    expect(aboveScroll).not.toHaveBeenCalled()
    expect(document.querySelector('[data-canopy-revealed]')).toBeNull()
  })

  it('scrolls a mark only partly in view', () => {
    const { getByTestId, parentWin } = renderPage(marked('a', 'a'))
    const scroll = place(getByTestId('a'), 740, 60)
    send(reveal('a'), parentWin)
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a path no mark or ancestor matches, after one retry', () => {
    const { getByTestId, parentWin } = renderPage(marked('a', 'title'))
    const scroll = place(getByTestId('a'), 2000)
    send(reveal('summary'), parentWin)
    act(() => vi.advanceTimersByTime(1000))
    expect(scroll).not.toHaveBeenCalled()
    expect(document.querySelector('[data-canopy-revealed]')).toBeNull()
  })

  it('finds a mark that renders just after the reveal arrives', () => {
    const { getByTestId, rerender, parentWin } = renderPage(marked('a', 'title'))
    place(getByTestId('a'), 10)
    send(reveal('summary'), parentWin)
    rerender(
      <Page>
        {marked('a', 'title')}
        {marked('late', 'summary')}
      </Page>,
    )
    const scroll = place(getByTestId('late'), 2000)
    act(() => vi.advanceTimersByTime(300))
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('skips a mark that is not rendered', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('hidden', 'title')}
        {marked('shown', 'title')}
      </>,
    )
    const hiddenScroll = vi.fn()
    getByTestId('hidden').scrollIntoView = hiddenScroll
    getByTestId('hidden').getClientRects = () => [] as unknown as DOMRectList
    const shownScroll = place(getByTestId('shown'), 2000)
    send(reveal('title'), parentWin)
    expect(hiddenScroll).not.toHaveBeenCalled()
    expect(shownScroll).toHaveBeenCalledTimes(1)
  })

  it('moves the mark to the latest element revealed', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        {marked('a', 'a')}
        {marked('b', 'b')}
      </>,
    )
    place(getByTestId('a'), 2000)
    place(getByTestId('b'), 3000)
    send(reveal('a'), parentWin)
    send(reveal('b'), parentWin)
    expect(getByTestId('a').hasAttribute('data-canopy-revealed')).toBe(false)
    expect(getByTestId('b').hasAttribute('data-canopy-revealed')).toBe(true)
  })

  it('leaves focus where it is', () => {
    const { getByTestId, parentWin } = renderPage(
      <>
        <input data-testid="field" />
        {marked('a', 'a')}
      </>,
    )
    place(getByTestId('a'), 2000)
    const field = getByTestId('field')
    field.focus()
    send(reveal('a'), parentWin)
    expect(document.activeElement).toBe(field)
  })

  describe('is ignored', () => {
    const scrolled = (data: unknown, origin?: string, source?: 'parent' | 'other') => {
      const { getByTestId, parentWin } = renderPage(marked('a', 'a'))
      const scroll = place(getByTestId('a'), 2000)
      const from = source === 'other' ? window : parentWin
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data,
            origin: origin ?? window.location.origin,
            source: from,
          }),
        )
      })
      act(() => vi.advanceTimersByTime(1000))
      return scroll.mock.calls.length
    }

    it('from another origin', () => {
      expect(scrolled(reveal('a'), 'https://evil.example')).toBe(0)
    })

    it('from a window other than the parent frame', () => {
      expect(scrolled(reveal('a'), undefined, 'other')).toBe(0)
    })

    it.each([[42], [null], [['a']], [{ path: 'a' }]])(
      'with a path that is not a string: %j',
      (path) => {
        expect(scrolled(reveal(path))).toBe(0)
      },
    )

    it('with a path longer than a mark report carries', () => {
      expect(scrolled(reveal(`a${'.b'.repeat(MARK_REPORT_LIMITS.pathLength)}`))).toBe(0)
    })

    it('when the page is not framed', () => {
      const { getByTestId } = render(<Page>{marked('a', 'a')}</Page>)
      const scroll = place(getByTestId('a'), 2000)
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: reveal('a'),
            origin: window.location.origin,
            source: window,
          }),
        )
      })
      expect(scroll).not.toHaveBeenCalled()
      expect(document.getElementById('canopycms-preview-reveal-style')).toBeNull()
    })
  })

  it('reaches a page through useCanopyPreview', () => {
    const View = () => {
      const { fieldProps } = useCanopyPreview<{ title: string }>({
        initialData: { title: 'Hello' },
      })
      return <h1 data-testid="title" {...fieldProps('title')} />
    }
    const parentWin = simulateFramed()
    const { getByTestId } = render(<View />)
    const scroll = place(getByTestId('title'), 2000)
    send(reveal('title'), parentWin)
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('honours a configured editorOrigin', () => {
    const { getByTestId, parentWin } = renderPage(marked('a', 'a'), 'https://editor.example')
    const scroll = place(getByTestId('a'), 2000)
    send(reveal('a'), parentWin)
    expect(scroll).not.toHaveBeenCalled()
    send(reveal('a'), parentWin, 'https://editor.example')
    expect(scroll).toHaveBeenCalledTimes(1)
  })
})

describe('findRevealTargets', () => {
  it('builds no selector from the path', () => {
    document.body.innerHTML = '<div data-canopy-path="a"></div>'
    place(document.querySelector('div') as HTMLElement, 0)
    expect(findRevealTargets('"]  *, [x="')).toEqual([])
    expect(findRevealTargets('')).toEqual([])
    document.body.innerHTML = ''
  })
})

describe('PreviewFrame reveals', () => {
  const renderFrame = (reveal?: { path: string; id: number }) => {
    const utils = render(
      <PreviewFrame src="/preview/x?branch=main" path="/x" data={{ v: 1 }} reveal={reveal} />,
    )
    const iframe = () => utils.container.querySelector('iframe') as HTMLIFrameElement
    const post = vi
      .spyOn(iframe().contentWindow as Window, 'postMessage')
      .mockImplementation(() => {})
    const ready = () =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: CANOPY_PREVIEW_READY, path: '/x' },
            origin: window.location.origin,
            source: iframe().contentWindow,
          }),
        )
      })
    const reveals = () =>
      post.mock.calls.filter(([msg]) => (msg as { type?: string }).type === CANOPY_PREVIEW_REVEAL)
    return { ...utils, iframe, post, ready, reveals }
  }

  it('waits for the page to connect, then sends the latest reveal to the preview origin', () => {
    const { ready, reveals, rerender } = renderFrame({ path: 'title', id: 1 })
    expect(reveals()).toEqual([])
    rerender(
      <PreviewFrame
        src="/preview/x?branch=main"
        path="/x"
        data={{ v: 1 }}
        reveal={{ path: 'summary', id: 2 }}
      />,
    )
    ready()
    expect(reveals()).toEqual([
      [{ type: CANOPY_PREVIEW_REVEAL, path: 'summary' }, window.location.origin],
    ])
  })

  it('sends each reveal once, and the same field again under a new id', () => {
    const { ready, reveals, rerender } = renderFrame({ path: 'title', id: 1 })
    ready()
    ready()
    rerender(
      <PreviewFrame
        src="/preview/x?branch=main"
        path="/x"
        data={{ v: 2 }}
        reveal={{ path: 'title', id: 1 }}
      />,
    )
    expect(reveals()).toHaveLength(1)
    rerender(
      <PreviewFrame
        src="/preview/x?branch=main"
        path="/x"
        data={{ v: 2 }}
        reveal={{ path: 'title', id: 2 }}
      />,
    )
    expect(reveals()).toHaveLength(2)
  })

  it('sends the reveal again to the next page the frame loads, once it connects', () => {
    const { ready, reveals, rerender, iframe } = renderFrame({ path: 'title', id: 1 })
    ready()
    expect(reveals()).toHaveLength(1)
    rerender(
      <PreviewFrame
        src="/preview/x?branch=main&chrome=1"
        path="/x"
        data={{ v: 1 }}
        reveal={{ path: 'title', id: 1 }}
      />,
    )
    const post = vi
      .spyOn(iframe().contentWindow as Window, 'postMessage')
      .mockImplementation(() => {})
    const sentReveals = () =>
      post.mock.calls.filter(([msg]) => (msg as { type?: string }).type === CANOPY_PREVIEW_REVEAL)
    expect(sentReveals()).toEqual([])
    ready()
    expect(sentReveals()).toEqual([
      [{ type: CANOPY_PREVIEW_REVEAL, path: 'title' }, window.location.origin],
    ])
  })

  it('sends nothing with no reveal', () => {
    const { ready, reveals } = renderFrame()
    ready()
    expect(reveals()).toEqual([])
  })
})
