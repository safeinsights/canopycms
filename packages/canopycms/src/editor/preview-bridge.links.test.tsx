import React, { useEffect, useRef } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CANOPY_PREVIEW_FOCUS,
  CANOPY_PREVIEW_NAVIGATE,
  useCanopyPreview,
  usePreviewFocusEmitter,
} from './preview-bridge'
import { PreviewFrame } from './PreviewFrame'

/** Runs the page inside an editor frame: `window.parent` becomes a separate jsdom window. */
const simulateFramed = () => {
  const host = document.createElement('iframe')
  document.body.appendChild(host)
  const parentWin = host.contentWindow as Window
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parentWin })
  return vi.spyOn(parentWin, 'postMessage').mockImplementation(() => {})
}

/**
 * Whether each click reached the end of its dispatch still to be followed. It then stops the
 * click, since jsdom implements no navigation.
 */
const recordFollowed = () => {
  const followed: boolean[] = []
  const listener = (event: MouseEvent) => {
    followed.push(!event.defaultPrevented)
    event.preventDefault()
  }
  window.addEventListener('click', listener)
  return {
    followed,
    stop: () => window.removeEventListener('click', listener),
  }
}

let stopRecording: (() => void) | undefined

afterEach(() => {
  cleanup()
  stopRecording?.()
  stopRecording = undefined
  Object.defineProperty(window, 'parent', { configurable: true, get: () => window })
  document.querySelectorAll('iframe').forEach((el) => el.remove())
  document.querySelectorAll('base').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

const Page = ({ children, editorOrigin }: { children: React.ReactNode; editorOrigin?: string }) => {
  useCanopyPreview<{ title: string }>({
    initialData: { title: 'x' },
    path: '/posts/here',
    editorOrigin,
  })
  return <main>{children}</main>
}

const setup = (children: React.ReactNode, editorOrigin?: string) => {
  const post = simulateFramed()
  const open = vi.spyOn(window, 'open').mockImplementation(() => null)
  const recorder = recordFollowed()
  stopRecording = recorder.stop
  const utils = render(<Page editorOrigin={editorOrigin}>{children}</Page>)
  const sent = (type: string) =>
    post.mock.calls.filter(([message]) => (message as { type?: string }).type === type)
  return { ...utils, post, open, followed: recorder.followed, sent }
}

const origin = window.location.origin

describe('a link clicked in the preview', () => {
  it('goes to the editor when it is to another page of the same origin', () => {
    const { getByText, followed, sent, open } = setup(<a href="/posts/other?tab=1">Other</a>)

    fireEvent.click(getByText('Other'))

    expect(followed).toEqual([false])
    expect(sent(CANOPY_PREVIEW_NAVIGATE)).toEqual([
      [{ type: CANOPY_PREVIEW_NAVIGATE, href: `${origin}/posts/other?tab=1` }, origin],
    ])
    expect(open).not.toHaveBeenCalled()
  })

  it('posts to the configured editor origin', () => {
    const { getByText, sent } = setup(<a href="/posts/other">Other</a>, 'https://editor.example')

    fireEvent.click(getByText('Other'))

    expect(sent(CANOPY_PREVIEW_NAVIGATE)).toEqual([
      [{ type: CANOPY_PREVIEW_NAVIGATE, href: `${origin}/posts/other` }, 'https://editor.example'],
    ])
  })

  it('opens a link to another origin in a new tab, cut off from this page', () => {
    const { getByText, followed, sent, open } = setup(
      <a href="https://elsewhere.example/about">Elsewhere</a>,
    )

    fireEvent.click(getByText('Elsewhere'))

    expect(followed).toEqual([false])
    expect(open).toHaveBeenCalledWith(
      'https://elsewhere.example/about',
      '_blank',
      'noopener,noreferrer',
    )
    expect(sent(CANOPY_PREVIEW_NAVIGATE)).toEqual([])
  })

  it('finds a link inside a shadow root', () => {
    const { getByTestId, sent } = setup(<div data-testid="host" />)
    const root = getByTestId('host').attachShadow({ mode: 'open' })
    const link = document.createElement('a')
    link.href = '/posts/shadow'
    root.appendChild(link)

    fireEvent.click(link)

    expect(sent(CANOPY_PREVIEW_NAVIGATE)).toEqual([
      [{ type: CANOPY_PREVIEW_NAVIGATE, href: `${origin}/posts/shadow` }, origin],
    ])
  })

  describe('is left to the browser', () => {
    it.each([
      ['a Cmd click', { metaKey: true }],
      ['a Ctrl click', { ctrlKey: true }],
      ['a Shift click', { shiftKey: true }],
      ['an Alt click', { altKey: true }],
      ['a middle click', { button: 1 }],
    ])('for %s', (_, init) => {
      const { getByText, followed, sent, open } = setup(<a href="/posts/other">Other</a>)

      fireEvent.click(getByText('Other'), init)

      expect(followed).toEqual([true])
      expect(sent(CANOPY_PREVIEW_NAVIGATE)).toEqual([])
      expect(open).not.toHaveBeenCalled()
    })

    // Set on the DOM, since React warns about rendering a `javascript:` href.
    it.each([
      ['a target', { href: '/posts/other', target: '_blank' }],
      ['download', { href: '/posts/other', download: '' }],
      ['a same-page fragment', { href: '#section' }],
      ['mailto:', { href: 'mailto:someone@example.com' }],
      ['tel:', { href: 'tel:+15550100' }],
      ['javascript:', { href: 'javascript:void(0)' }],
    ])('for a link with %s', (_, attributes) => {
      const { getByText, followed, sent, open } = setup(<a>x</a>)
      const anchor = getByText('x')
      for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value)

      fireEvent.click(anchor)

      expect(followed).toEqual([true])
      expect(sent(CANOPY_PREVIEW_NAVIGATE)).toEqual([])
      expect(open).not.toHaveBeenCalled()
    })

    it("for a link the document's base sends to another target", () => {
      const base = document.createElement('base')
      base.setAttribute('target', '_blank')
      document.head.appendChild(base)
      const { getByText, followed, sent } = setup(<a href="/posts/other">Other</a>)

      fireEvent.click(getByText('Other'))

      expect(followed).toEqual([true])
      expect(sent(CANOPY_PREVIEW_NAVIGATE)).toEqual([])
    })

    it('when the page is not framed', () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      const recorder = recordFollowed()
      stopRecording = recorder.stop
      const { getByText } = render(
        <Page>
          <a href="/posts/other">Other</a>
        </Page>,
      )

      fireEvent.click(getByText('Other'))

      expect(recorder.followed).toEqual([true])
      expect(open).not.toHaveBeenCalled()
    })
  })

  describe('inside an element marked for click-to-focus', () => {
    it('navigates without focusing the field', () => {
      const { getByText, sent } = setup(
        <div data-canopy-path="title">
          <a href="/posts/other">Other</a> and text
        </div>,
      )

      fireEvent.click(getByText('Other'))

      expect(sent(CANOPY_PREVIEW_NAVIGATE)).toHaveLength(1)
      expect(sent(CANOPY_PREVIEW_FOCUS)).toEqual([])
    })

    it('focuses nothing on a click the browser follows', () => {
      const { getByText, sent } = setup(
        <div data-canopy-path="title">
          <a href="/posts/other">Other</a>
        </div>,
      )

      fireEvent.click(getByText('Other'), { metaKey: true })

      expect(sent(CANOPY_PREVIEW_FOCUS)).toEqual([])
    })

    it('still focuses the field on a click beside the link, or on a same-page fragment', () => {
      const { getByText, sent } = setup(
        <div data-canopy-path="title">
          <a href="/posts/other">Other</a> <span>text</span> <a href="#more">More</a>
        </div>,
      )

      fireEvent.click(getByText('text'))
      fireEvent.click(getByText('More'))

      expect(sent(CANOPY_PREVIEW_FOCUS)).toEqual([
        [{ type: CANOPY_PREVIEW_FOCUS, entryPath: '/posts/here', fieldPath: 'title' }, origin],
        [{ type: CANOPY_PREVIEW_FOCUS, entryPath: '/posts/here', fieldPath: 'title' }, origin],
      ])
    })
  })

  // A page composing the hooks itself, without `usePreviewLinkNavigation`, keeps the browser's
  // navigation; a link it stops on its own still focuses.
  describe('on a page running only the focus emitter', () => {
    const FocusOnly = ({ stop }: { stop: boolean }) => {
      usePreviewFocusEmitter('/posts/here')
      const ref = useRef<HTMLAnchorElement>(null)
      useEffect(() => {
        const link = ref.current
        if (!stop || !link) return
        const handler = (event: MouseEvent) => event.preventDefault()
        link.addEventListener('click', handler)
        return () => link.removeEventListener('click', handler)
      }, [stop])
      return (
        <div data-canopy-path="title">
          <a ref={ref} href="/posts/other">
            Other
          </a>
        </div>
      )
    }

    it.each([
      ['focuses nothing when the browser follows the link', false, 0],
      ['focuses the field when the page stops the link', true, 1],
    ])('%s', (_, stop, focuses) => {
      const post = simulateFramed()
      const recorder = recordFollowed()
      stopRecording = recorder.stop
      const { getByText } = render(<FocusOnly stop={stop} />)

      fireEvent.click(getByText('Other'))

      expect(recorder.followed).toEqual([!stop])
      expect(
        post.mock.calls.filter(
          ([message]) => (message as { type?: string }).type === CANOPY_PREVIEW_FOCUS,
        ),
      ).toHaveLength(focuses)
    })
  })
})

describe('PreviewFrame - links clicked in the preview', () => {
  const renderFrame = (src = '/preview/x?branch=main') => {
    const onNavigate = vi.fn()
    const { container } = render(
      <PreviewFrame src={src} path="/x" data={{ v: 1 }} onNavigate={onNavigate} />,
    )
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    const send = (
      data: unknown,
      {
        from = origin,
        source = iframe.contentWindow,
      }: { from?: string; source?: Window | null } = {},
    ) => window.dispatchEvent(new MessageEvent('message', { data, origin: from, source }))
    return { onNavigate, send }
  }

  it('passes on a trusted link to a page of the preview origin', async () => {
    const { onNavigate, send } = renderFrame()

    send({ type: CANOPY_PREVIEW_NAVIGATE, href: `${origin}/posts/other` })

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(`${origin}/posts/other`))
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('ignores a message from another origin or another window', async () => {
    const { onNavigate, send } = renderFrame()
    const message = { type: CANOPY_PREVIEW_NAVIGATE, href: `${origin}/posts/other` }

    send(message, { from: 'https://evil.example' })
    send(message, { source: window })
    send(message, { source: null })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it.each([
    ['no href', { type: CANOPY_PREVIEW_NAVIGATE }],
    [
      // One that stringifies to a URL the origin check passes.
      'an href that is not a string',
      { type: CANOPY_PREVIEW_NAVIGATE, href: [`${origin}/posts/other`] },
    ],
    ['a relative href', { type: CANOPY_PREVIEW_NAVIGATE, href: '/posts/other' }],
    ['a javascript: href', { type: CANOPY_PREVIEW_NAVIGATE, href: 'javascript:alert(1)' }],
    ['a data: href', { type: CANOPY_PREVIEW_NAVIGATE, href: 'data:text/html,x' }],
    // A blob: URL carries the origin that made it, so the origin check alone would pass it.
    ['a blob: href', { type: CANOPY_PREVIEW_NAVIGATE, href: `blob:${origin}/0a1b2c3d` }],
    [
      'an href on another origin',
      { type: CANOPY_PREVIEW_NAVIGATE, href: 'https://evil.example/x' },
    ],
    ['a payload that is not an object', CANOPY_PREVIEW_NAVIGATE],
  ])('ignores a message with %s', async (_, data) => {
    const { onNavigate, send } = renderFrame()

    send(data)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('takes links on the origin of an absolute preview src', async () => {
    const { onNavigate, send } = renderFrame('https://site.example/preview/x')

    send(
      { type: CANOPY_PREVIEW_NAVIGATE, href: `${origin}/posts/other` },
      { from: 'https://site.example' },
    )
    send(
      { type: CANOPY_PREVIEW_NAVIGATE, href: 'https://site.example/posts/other' },
      { from: 'https://site.example' },
    )

    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1))
    expect(onNavigate).toHaveBeenCalledWith('https://site.example/posts/other')
  })
})
