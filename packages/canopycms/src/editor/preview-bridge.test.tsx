import React, { memo } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'

import {
  CANOPY_PREVIEW_ERROR,
  CANOPY_PREVIEW_FOCUS,
  CANOPY_PREVIEW_HIGHLIGHT,
  CANOPY_PREVIEW_MARKS,
  CANOPY_PREVIEW_MESSAGE,
  CANOPY_PREVIEW_READY,
  isTrustedEditorMessage,
  resolveMessageOrigin,
  useCanopyPreview,
  usePreviewAssetBaseGate,
  type PreviewLoadingState,
} from './preview-bridge'
import type { TypeFromEntrySchema } from '../entry-schema'
import { PreviewFrame } from './PreviewFrame'
import { buildPreviewSrc } from './editor-utils'
import { assetUrl } from '../assets/asset-url'
import { getPreviewAssetBase, setServerPreviewAssetBaseGetter } from './preview-asset-base'

/**
 * Simulate running inside an editor iframe: window.parent becomes a real
 * (separate) jsdom window so source checks compare against a genuine WindowProxy.
 */
const simulateFramed = () => {
  const host = document.createElement('iframe')
  document.body.appendChild(host)
  const parentWin = host.contentWindow as Window
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parentWin })
  vi.spyOn(parentWin, 'postMessage').mockImplementation(() => {})
  return parentWin
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'parent', { configurable: true, get: () => window })
  document.querySelectorAll('iframe').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

const trustedEvent = (data: unknown, parentWin: Window, origin?: string) =>
  new MessageEvent('message', {
    data,
    origin: origin ?? window.location.origin,
    source: parentWin,
  })

const PreviewValue = ({
  initialData,
  path,
  editorOrigin,
}: {
  initialData: { value: string }
  path?: string
  editorOrigin?: string
}) => {
  const { data, highlightEnabled, fieldProps } = useCanopyPreview<{ value: string }>({
    initialData,
    path,
    editorOrigin,
  })
  return (
    <div data-testid="value" data-highlight={String(highlightEnabled)} {...fieldProps('value')}>
      {data.value}
    </div>
  )
}

describe('resolveMessageOrigin', () => {
  it('defaults to the page origin', () => {
    expect(resolveMessageOrigin()).toBe(window.location.origin)
  })

  it('resolves relative URLs to the page origin', () => {
    expect(resolveMessageOrigin('/preview/x?branch=main')).toBe(window.location.origin)
  })

  it('resolves absolute URLs to their own origin', () => {
    expect(resolveMessageOrigin('https://editor.example/some/path')).toBe('https://editor.example')
  })

  it('falls back to the page origin for unparseable URLs', () => {
    expect(resolveMessageOrigin('http://')).toBe(window.location.origin)
  })
})

describe('isTrustedEditorMessage', () => {
  it('rejects everything when not framed', () => {
    const event = new MessageEvent('message', {
      data: {},
      origin: window.location.origin,
      source: window,
    })
    expect(isTrustedEditorMessage(event)).toBe(false)
  })

  it('accepts same-origin messages from the parent frame', () => {
    const parentWin = simulateFramed()
    expect(isTrustedEditorMessage(trustedEvent({}, parentWin))).toBe(true)
  })

  it('rejects messages from other origins', () => {
    const parentWin = simulateFramed()
    expect(isTrustedEditorMessage(trustedEvent({}, parentWin, 'https://evil.example'))).toBe(false)
  })

  it('rejects messages whose source is not the parent frame', () => {
    simulateFramed()
    const event = new MessageEvent('message', {
      data: {},
      origin: window.location.origin,
      source: window,
    })
    expect(isTrustedEditorMessage(event)).toBe(false)
  })

  it('honors an explicit editorOrigin instead of same-origin', () => {
    const parentWin = simulateFramed()
    expect(
      isTrustedEditorMessage(
        trustedEvent({}, parentWin, 'https://editor.example'),
        'https://editor.example',
      ),
    ).toBe(true)
    expect(isTrustedEditorMessage(trustedEvent({}, parentWin), 'https://editor.example')).toBe(
      false,
    )
  })
})

describe('useCanopyPreview', () => {
  it('uses the current location when path is omitted', async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/hello-world?branch=main')
    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      trustedEvent(
        {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/posts/hello-world?branch=main',
          data: { value: 'updated' },
        },
        parentWin,
      ),
    )

    await waitFor(() => expect(getByTestId('value').textContent).toBe('updated'))
  })

  it('prefers the provided path over the current location', async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/different?branch=main')
    const { getByTestId } = render(
      <PreviewValue initialData={{ value: 'initial' }} path="/posts/override?branch=main" />,
    )

    window.dispatchEvent(
      trustedEvent(
        {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/posts/override?branch=main',
          data: { value: 'updated' },
        },
        parentWin,
      ),
    )

    await waitFor(() => expect(getByTestId('value').textContent).toBe('updated'))
  })

  // buildPreviewSrc (editor-utils.ts) and resolvePreviewPath's window.location fallback
  // (this file) are computed independently -- one by the editor building the iframe `src`,
  // the other by the preview page reading its own browser URL -- but MUST produce identical
  // strings, or usePreviewData's `msg.path !== path` check silently drops every draft update
  // (see editor-utils.ts's buildPreviewSrc doc comment). Next.js does NOT strip a configured
  // `basePath` from the raw browser URL, so the served page's window.location.pathname
  // literally includes it -- this proves buildPreviewSrc's basePath-prefixed output matches
  // that real value byte-for-byte.
  it("accepts a draft update whose path is buildPreviewSrc's basePath-prefixed output", async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/preview-123/docs/overview?branch=main')

    const previewSrc = buildPreviewSrc(
      { collectionPath: 'content/docs', slug: 'overview' },
      { branchName: 'main', basePath: '/preview-123' },
    )
    // The invariant itself, checked directly before relying on it below.
    expect(previewSrc).toBe(`${window.location.pathname}${window.location.search}`)

    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      trustedEvent(
        { type: CANOPY_PREVIEW_MESSAGE, path: previewSrc, data: { value: 'updated' } },
        parentWin,
      ),
    )

    await waitFor(() => expect(getByTestId('value').textContent).toBe('updated'))
  })

  // The failure mode the basePath fix addresses: an UNprefixed previewSrc (what buildPreviewSrc
  // produced before this change) silently stops matching window.location once the app is
  // deployed under a basePath -- no error, the update just never arrives.
  it('rejects a draft update whose path omits the basePath the real page is served under', async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/preview-123/docs/overview?branch=main')

    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      trustedEvent(
        {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/docs/overview?branch=main',
          data: { value: 'updated' },
        },
        parentWin,
      ),
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getByTestId('value').textContent).toBe('initial')
  })

  describe('the same page spelled two ways', () => {
    const draftArrives = async (pageUrl: string, editorPath: unknown) => {
      const parentWin = simulateFramed()
      window.history.pushState({}, '', pageUrl)
      const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)
      window.dispatchEvent(
        trustedEvent(
          { type: CANOPY_PREVIEW_MESSAGE, path: editorPath, data: { value: 'updated' } },
          parentWin,
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      return getByTestId('value').textContent === 'updated'
    }

    it('applies a draft after the host redirected the src to its slashed form', async () => {
      const editorPath = buildPreviewSrc(
        { collectionPath: 'content/blog', slug: 'x' },
        { branchName: 'b', trailingSlash: false },
      )
      expect(editorPath).toBe('/blog/x?branch=b')
      expect(await draftArrives('/blog/x/?branch=b', editorPath)).toBe(true)
    })

    it('applies a draft after the host redirected the src to its unslashed form', async () => {
      expect(await draftArrives('/blog/x?branch=b', '/blog/x/?branch=b')).toBe(true)
    })

    it('builds exactly the URL a slashed host serves under a prefix, so nothing redirects', () => {
      const src = buildPreviewSrc(
        { collectionPath: 'content/blog', slug: 'x' },
        { branchName: 'b', previewPrefix: '/preview', basePath: '/base', trailingSlash: true },
      )
      expect(src).toBe('/base/preview/blog/x/?branch=b')
    })

    it('applies a draft addressed by an absolute src on the page origin', async () => {
      expect(
        await draftArrives(
          '/preview/blog/x/?branch=b',
          `${window.location.origin}/preview/blog/x?branch=b`,
        ),
      ).toBe(true)
    })

    it('drops a draft for the same path on another branch', async () => {
      expect(await draftArrives('/blog/x/?branch=b', '/blog/x?branch=other')).toBe(false)
    })

    it('drops a draft for another page', async () => {
      expect(await draftArrives('/blog/x/?branch=b', '/blog/y?branch=b')).toBe(false)
    })

    it('drops a draft whose path is not a string', async () => {
      expect(await draftArrives('/blog/x/?branch=b', { toString: () => '/blog/x/?branch=b' })).toBe(
        false,
      )
    })
  })

  it('ignores draft messages when not framed', async () => {
    window.history.pushState({}, '', '/posts/standalone')
    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_MESSAGE, path: '/posts/standalone', data: { value: 'pwned' } },
        origin: window.location.origin,
        source: window,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getByTestId('value').textContent).toBe('initial')
  })

  it('ignores draft messages from a different origin', async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/secure')
    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      trustedEvent(
        { type: CANOPY_PREVIEW_MESSAGE, path: '/posts/secure', data: { value: 'pwned' } },
        parentWin,
        'https://evil.example',
      ),
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getByTestId('value').textContent).toBe('initial')
  })

  it('ignores draft messages whose source is not the parent frame', async () => {
    simulateFramed()
    window.history.pushState({}, '', '/posts/secure-source')
    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/posts/secure-source',
          data: { value: 'pwned' },
        },
        origin: window.location.origin,
        source: window,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getByTestId('value').textContent).toBe('initial')
  })

  it('accepts messages from a configured editorOrigin', async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/cross-origin')
    const { getByTestId } = render(
      <PreviewValue initialData={{ value: 'initial' }} editorOrigin="https://editor.example" />,
    )

    window.dispatchEvent(
      trustedEvent(
        { type: CANOPY_PREVIEW_MESSAGE, path: '/posts/cross-origin', data: { value: 'updated' } },
        parentWin,
        'https://editor.example',
      ),
    )

    await waitFor(() => expect(getByTestId('value').textContent).toBe('updated'))
  })

  it('toggles highlight only for trusted messages', async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/highlight')
    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    window.dispatchEvent(
      trustedEvent(
        { type: CANOPY_PREVIEW_HIGHLIGHT, enabled: true },
        parentWin,
        'https://evil.example',
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getByTestId('value').dataset.highlight).toBe('false')

    window.dispatchEvent(trustedEvent({ type: CANOPY_PREVIEW_HIGHLIGHT, enabled: true }, parentWin))
    await waitFor(() => expect(getByTestId('value').dataset.highlight).toBe('true'))
  })

  describe('the mark count', () => {
    const setUp = () => {
      const parentWin = simulateFramed()
      window.history.pushState({}, '', '/posts/marks')
      render(<PreviewValue initialData={{ value: 'initial' }} />)
      const counts = () =>
        vi
          .mocked(parentWin.postMessage)
          .mock.calls.filter(([msg]) => (msg as { type?: string }).type === CANOPY_PREVIEW_MARKS)
      const highlight = (enabled: boolean, origin?: string) =>
        act(() => {
          window.dispatchEvent(
            trustedEvent({ type: CANOPY_PREVIEW_HIGHLIGHT, enabled }, parentWin, origin),
          )
        })
      const addMark = (path: string) =>
        act(() => {
          const el = document.createElement('span')
          el.setAttribute('data-canopy-path', path)
          document.body.appendChild(el)
          onTestFinished(() => el.remove())
        })
      return { counts, highlight, addMark }
    }

    it('is reported to the editor origin once trusted highlighting turns on', async () => {
      const { counts, highlight } = setUp()

      highlight(false)
      highlight(true, 'https://evil.example')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(counts()).toEqual([])

      highlight(true)
      await waitFor(() =>
        expect(counts()).toEqual([
          [{ type: CANOPY_PREVIEW_MARKS, count: 1 }, window.location.origin],
        ]),
      )
    })

    it('is reported again when the marks change while highlighting is on, and not after', async () => {
      const { counts, highlight, addMark } = setUp()
      highlight(true)
      await waitFor(() => expect(counts()).toHaveLength(1))

      addMark('extra')
      await waitFor(() =>
        expect(counts().map(([msg]) => msg)).toEqual([
          { type: CANOPY_PREVIEW_MARKS, count: 1 },
          { type: CANOPY_PREVIEW_MARKS, count: 2 },
        ]),
      )

      highlight(false)
      addMark('later')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(counts()).toHaveLength(2)
    })

    it('is reported within the throttle while the page keeps changing', async () => {
      const { counts, highlight, addMark } = setUp()
      highlight(true)
      await waitFor(() => expect(counts()).toHaveLength(1))

      addMark('extra')
      const churn = setInterval(() => document.body.append(document.createElement('i')), 20)
      onTestFinished(() => {
        clearInterval(churn)
        document.querySelectorAll('body > i').forEach((el) => el.remove())
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(counts().map(([msg]) => msg)).toContainEqual({ type: CANOPY_PREVIEW_MARKS, count: 2 })
    })
  })

  it('posts the ready handshake to the editor origin, never *', () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/ready')
    render(<PreviewValue initialData={{ value: 'initial' }} />)

    expect(parentWin.postMessage).toHaveBeenCalledWith(
      { type: CANOPY_PREVIEW_READY, path: '/posts/ready' },
      window.location.origin,
    )
  })

  it('posts the ready handshake to a configured editorOrigin', () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/ready-cross')
    render(
      <PreviewValue initialData={{ value: 'initial' }} editorOrigin="https://editor.example" />,
    )

    expect(parentWin.postMessage).toHaveBeenCalledWith(
      { type: CANOPY_PREVIEW_READY, path: '/posts/ready-cross' },
      'https://editor.example',
    )
  })

  it('does not post the ready handshake when not framed', () => {
    window.history.pushState({}, '', '/posts/standalone-ready')
    render(<PreviewValue initialData={{ value: 'initial' }} />)
    // No parent to post to; nothing to assert beyond not throwing.
  })

  it('emits focus clicks to the editor origin', async () => {
    const parentWin = simulateFramed()
    window.history.pushState({}, '', '/posts/focus')
    const { getByTestId } = render(<PreviewValue initialData={{ value: 'initial' }} />)

    fireEvent.click(getByTestId('value'))

    await waitFor(() =>
      expect(parentWin.postMessage).toHaveBeenCalledWith(
        { type: CANOPY_PREVIEW_FOCUS, entryPath: '/posts/focus', fieldPath: 'value' },
        window.location.origin,
      ),
    )
  })
})

describe('PreviewFrame', () => {
  const renderFrame = () => {
    const utils = render(
      <PreviewFrame src="/preview/x?branch=main" path="/x" data={{ value: 'draft' }} />,
    )
    const iframe = utils.container.querySelector('iframe') as HTMLIFrameElement
    const postSpy = vi
      .spyOn(iframe.contentWindow as Window, 'postMessage')
      .mockImplementation(() => {})
    return { ...utils, iframe, postSpy }
  }

  it('posts drafts to the preview origin derived from src, never *', () => {
    const { iframe, postSpy } = renderFrame()
    fireEvent.load(iframe)
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: CANOPY_PREVIEW_MESSAGE, path: '/x' }),
      window.location.origin,
    )
  })

  it('responds to a ready handshake only from the preview origin', async () => {
    const { iframe, postSpy } = renderFrame()
    postSpy.mockClear()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_READY, path: '/x' },
        origin: 'https://evil.example',
        source: iframe.contentWindow,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(postSpy).not.toHaveBeenCalled()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_READY, path: '/x' },
        origin: window.location.origin,
        source: iframe.contentWindow,
      }),
    )
    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: CANOPY_PREVIEW_MESSAGE }),
        window.location.origin,
      ),
    )
  })
})

describe('PreviewFrame - assetBase', () => {
  const postedDraft = (src: string, assetBase?: string): unknown => {
    const { container } = render(
      <PreviewFrame src={src} path="/x" data={{ value: 'draft' }} assetBase={assetBase} />,
    )
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    const postSpy = vi
      .spyOn(iframe.contentWindow as Window, 'postMessage')
      .mockImplementation(() => {})
    fireEvent.load(iframe)
    return postSpy.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === CANOPY_PREVIEW_MESSAGE,
    )?.[0]
  }

  it('sends the asset base with the draft to a same-origin preview', () => {
    expect(postedDraft('/preview/x', '/p/api/canopycms/assets/raw')).toMatchObject({
      assetBase: '/p/api/canopycms/assets/raw',
    })
  })

  it('withholds it from a preview on another origin', () => {
    const draft = postedDraft('https://site.example/preview/x', '/p/api/canopycms/assets/raw')
    expect(draft).toMatchObject({ type: CANOPY_PREVIEW_MESSAGE })
    expect(draft).not.toHaveProperty('assetBase')
  })
})

describe('useCanopyPreview - the asset base from a draft drives assetUrl', () => {
  const HASH = 'a'.repeat(32)
  const transformSrc = `/assets/t/orig/${HASH}/photo.png`
  const staticSrc = `/assets/${HASH}/logo.svg`

  const Images = ({ baseUrl }: { baseUrl?: string }) => {
    const { data } = useCanopyPreview<{ crop: string }>({
      initialData: { crop: 'none' },
      path: '/posts/img',
    })
    const crop = data.crop === 'set' ? { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } : undefined
    return (
      <>
        <img
          data-testid="transform"
          alt=""
          src={assetUrl({ src: transformSrc, crop }, { baseUrl })}
        />
        <img data-testid="static" alt="" src={assetUrl({ src: staticSrc }, { baseUrl })} />
      </>
    )
  }

  const sendDraft = (parentWin: Window, extra: Record<string, unknown>) =>
    window.dispatchEvent(
      trustedEvent(
        { type: CANOPY_PREVIEW_MESSAGE, path: '/posts/img', data: { crop: 'set' }, ...extra },
        parentWin,
      ),
    )

  it('puts transform srcs behind it, over an off-origin baseUrl, and leaves static srcs alone', async () => {
    const parentWin = simulateFramed()
    const { getByTestId } = render(<Images baseUrl="https://cdn.example.com" />)
    expect(getByTestId('transform').getAttribute('src')).toBe(
      `https://cdn.example.com${transformSrc}`,
    )

    sendDraft(parentWin, { assetBase: '/p/api/canopycms/assets/raw' })

    await waitFor(() =>
      expect(getByTestId('transform').getAttribute('src')).toBe(
        `/p/api/canopycms/assets/raw/assets/t/c=0.1000:0.2000:0.5000:0.2500/${HASH}/photo.png`,
      ),
    )
    expect(getByTestId('static').getAttribute('src')).toBe(`https://cdn.example.com${staticSrc}`)
  })

  it.each([
    ['an off-origin URL', 'https://evil.example/raw'],
    ['a protocol-relative path', '//evil.example/raw'],
    ['a backslash spelling of one', '/\\evil.example/raw'],
    ['a relative path', 'api/canopycms/assets/raw'],
    ['a non-string', 42],
  ])('ignores %s', async (_label, assetBase) => {
    const parentWin = simulateFramed()
    const { getByTestId } = render(<Images />)

    sendDraft(parentWin, { assetBase })

    await waitFor(() =>
      expect(getByTestId('transform').getAttribute('src')).toBe(
        `/assets/t/c=0.1000:0.2000:0.5000:0.2500/${HASH}/photo.png`,
      ),
    )
  })

  it('drops an earlier asset base when a later draft carries none', async () => {
    const parentWin = simulateFramed()
    const { getByTestId } = render(<Images />)
    sendDraft(parentWin, { assetBase: '/api/canopycms/assets/raw' })
    await waitFor(() =>
      expect(getByTestId('transform').getAttribute('src')).toMatch(
        /^\/api\/canopycms\/assets\/raw\//,
      ),
    )

    sendDraft(parentWin, { data: { crop: 'none' } })

    await waitFor(() => expect(getByTestId('transform').getAttribute('src')).toBe(transformSrc))
  })

  it('is not set by an untrusted message', async () => {
    simulateFramed()
    render(<Images />)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/posts/img',
          data: { crop: 'set' },
          assetBase: '/api/canopycms/assets/raw',
        },
        origin: 'https://evil.example',
        source: window.parent,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(getPreviewAssetBase()).toBeUndefined()
  })
})

describe('usePreviewAssetBaseGate - a createPreviewPage view', () => {
  const HASH = 'b'.repeat(32)
  const crop = { src: `/assets/t/orig/${HASH}/photo.png` }
  const RAW = '/api/canopycms/assets/raw'
  const atWidth = (width: number) => `/assets/t/w=${width}/${HASH}/photo.png`

  // Every src ever rendered, so a public first render cannot hide behind a later fix.
  let rendered: string[] = []
  const Img = ({ width }: { width: number }) => {
    const src = assetUrl(crop, { width })
    rendered.push(src)
    return <img data-testid={`w${width}`} alt="" src={src} />
  }
  // Memoized with props that never change, so it renders exactly once.
  const MemoSibling = memo(function MemoSibling() {
    return <Img width={640} />
  })

  const GatedView = ({ assetBase }: { assetBase?: unknown }) => {
    const { data } = useCanopyPreview<{ title: string }>({
      initialData: { title: 'Saved' },
      path: '/posts/gated',
    })
    const open = usePreviewAssetBaseGate(assetBase)
    return open ? (
      <main>
        <h1>{data.title}</h1>
        <Img width={320} />
        <MemoSibling />
      </main>
    ) : (
      <></>
    )
  }

  afterEach(() => {
    rendered = []
  })

  it('renders nothing on the server, then hydrates cleanly with every image behind the route', async () => {
    const consoleError = vi.spyOn(console, 'error')
    vi.stubGlobal('window', undefined)
    let html: string
    try {
      html = renderToString(<GatedView assetBase={RAW} />)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(html).not.toContain('<img')
    expect(html).not.toContain('/assets/t/')
    expect(rendered).toEqual([])

    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)
    const onRecoverableError = vi.fn()
    const root = await act(async () =>
      hydrateRoot(container, <GatedView assetBase={RAW} />, { onRecoverableError }),
    )
    onTestFinished(() => {
      act(() => root.unmount())
      container.remove()
    })

    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    expect(rendered).toEqual([`${RAW}${atWidth(320)}`, `${RAW}${atWidth(640)}`])
    expect(container.querySelector('[data-testid="w640"]')?.getAttribute('src')).toBe(
      `${RAW}${atWidth(640)}`,
    )
  })

  it('renders on the server at once with no asset base, as on a public page', () => {
    vi.stubGlobal('window', undefined)
    let html: string
    try {
      html = renderToString(<GatedView />)
    } finally {
      vi.unstubAllGlobals()
    }

    expect(html).toContain(`src="${atWidth(320)}"`)
    expect(html).toContain(`src="${atWidth(640)}"`)
  })

  it.each([
    ['an off-origin URL', 'https://evil.example/raw'],
    ['a protocol-relative path', '//evil.example/raw'],
    ['a backslash spelling of one', '/\\evil.example/raw'],
    ['a relative path', 'api/canopycms/assets/raw'],
    ['a non-string', 42],
  ])('ignores %s, rendering public URLs', async (_label, assetBase) => {
    const { findByTestId } = render(<GatedView assetBase={assetBase} />)

    expect((await findByTestId('w320')).getAttribute('src')).toBe(atWidth(320))
    expect(getPreviewAssetBase()).toBeUndefined()
  })

  it('is never steered by a server-side getter in a browser', () => {
    setServerPreviewAssetBaseGetter(() => '/server/raw')
    onTestFinished(() => setServerPreviewAssetBaseGetter(undefined))

    expect(assetUrl(crop, { width: 320 })).toBe(atWidth(320))
  })

  it("gives way to a later draft's asset base", async () => {
    const parentWin = simulateFramed()
    const { findByTestId, getByTestId, rerender } = render(<GatedView assetBase={RAW} />)
    expect((await findByTestId('w320')).getAttribute('src')).toBe(`${RAW}${atWidth(320)}`)

    window.dispatchEvent(
      trustedEvent(
        {
          type: CANOPY_PREVIEW_MESSAGE,
          path: '/posts/gated',
          data: { title: 'Draft' },
          assetBase: '/other/raw',
        },
        parentWin,
      ),
    )

    await waitFor(() =>
      expect(getByTestId('w320').getAttribute('src')).toBe(`/other/raw${atWidth(320)}`),
    )
    // And keeps it through a re-render the draft did not cause.
    rerender(<GatedView assetBase={RAW} />)
    expect(getByTestId('w320').getAttribute('src')).toBe(`/other/raw${atWidth(320)}`)
  })
})

describe('preview error channel', () => {
  const ErrorReporter = ({ error }: { error: string | null }) => {
    const { reportError } = useCanopyPreview<{ value: string }>({
      initialData: { value: 'x' },
      path: '/posts/err',
    })
    return <button data-testid="report" onClick={() => reportError(error, 'body')} />
  }

  it('reportError posts to the editor origin when framed', () => {
    const parentWin = simulateFramed()
    const { getByTestId } = render(<ErrorReporter error="MDX failed to compile" />)

    fireEvent.click(getByTestId('report'))

    expect(parentWin.postMessage).toHaveBeenCalledWith(
      {
        type: CANOPY_PREVIEW_ERROR,
        path: '/posts/err',
        message: 'MDX failed to compile',
        fieldPath: 'body',
      },
      window.location.origin,
    )
  })

  it('reportError is a no-op when not framed', () => {
    const { getByTestId } = render(<ErrorReporter error="MDX failed to compile" />)
    fireEvent.click(getByTestId('report'))
    // Nothing to assert beyond not throwing: there is no parent to post to.
  })

  it('PreviewFrame surfaces trusted error reports and clears on null', async () => {
    const onPreviewError = vi.fn()
    const { container } = render(
      <PreviewFrame src="/preview/x" path="/x" data={{ v: 1 }} onPreviewError={onPreviewError} />,
    )
    const iframe = container.querySelector('iframe') as HTMLIFrameElement

    // Wrong origin: ignored
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_ERROR, path: '/x', message: 'forged' },
        origin: 'https://evil.example',
        source: iframe.contentWindow,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onPreviewError).not.toHaveBeenCalled()

    // Trusted error report
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: CANOPY_PREVIEW_ERROR,
          path: '/x',
          message: 'compile failed',
          fieldPath: 'body',
        },
        origin: window.location.origin,
        source: iframe.contentWindow,
      }),
    )
    await waitFor(() =>
      expect(onPreviewError).toHaveBeenCalledWith({ message: 'compile failed', fieldPath: 'body' }),
    )

    // Null clears
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_ERROR, path: '/x', message: null },
        origin: window.location.origin,
        source: iframe.contentWindow,
      }),
    )
    await waitFor(() => expect(onPreviewError).toHaveBeenLastCalledWith(null))
  })

  it('PreviewFrame reports the mark count a trusted preview sends, and nothing else', async () => {
    const onMarkCount = vi.fn()
    const { container } = render(
      <PreviewFrame src="/preview/x" path="/x" data={{ v: 1 }} onMarkCount={onMarkCount} />,
    )
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    const send = (data: unknown, origin = window.location.origin) =>
      window.dispatchEvent(
        new MessageEvent('message', { data, origin, source: iframe.contentWindow }),
      )

    send({ type: CANOPY_PREVIEW_MARKS, count: 3 }, 'https://evil.example')
    send({ type: CANOPY_PREVIEW_MARKS, count: '3' })
    send({ type: CANOPY_PREVIEW_MARKS, count: -1 })
    send({ type: CANOPY_PREVIEW_MARKS, count: 1.5 })
    send({ type: CANOPY_PREVIEW_MARKS })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onMarkCount).not.toHaveBeenCalled()

    send({ type: CANOPY_PREVIEW_MARKS, count: 0 })
    await waitFor(() => expect(onMarkCount).toHaveBeenCalledWith(0))
    expect(onMarkCount).toHaveBeenCalledTimes(1)
  })

  it('ignores error reports whose message is not a string', async () => {
    const onPreviewError = vi.fn()
    const { container } = render(
      <PreviewFrame src="/preview/x" path="/x" data={{ v: 1 }} onPreviewError={onPreviewError} />,
    )
    const iframe = container.querySelector('iframe') as HTMLIFrameElement

    // An adopter mistake like reportError(err) would put an object here —
    // forwarding it would crash the editor when rendered as a React child
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: CANOPY_PREVIEW_ERROR, path: '/x', message: { name: 'Error' } },
        origin: window.location.origin,
        source: iframe.contentWindow,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onPreviewError).not.toHaveBeenCalled()
  })
})

describe('opaque-origin (sandboxed embed) handling', () => {
  // 'data:' URLs resolve to the opaque origin string 'null' — the same value
  // every window in a sandboxed embed reports, so it must never be trusted.
  const OPAQUE_URL = 'data:text/plain,x'

  it('resolveMessageOrigin resolves data: URLs to the opaque origin string', () => {
    expect(resolveMessageOrigin(OPAQUE_URL)).toBe('null')
  })

  it('isTrustedEditorMessage rejects matching opaque origins', () => {
    const parentWin = simulateFramed()
    const event = new MessageEvent('message', {
      data: {},
      origin: 'null',
      source: parentWin,
    })
    expect(isTrustedEditorMessage(event, OPAQUE_URL)).toBe(false)
  })

  it('reportError does not post when the editor origin is opaque', () => {
    const parentWin = simulateFramed()
    const Reporter = () => {
      const { reportError } = useCanopyPreview<{ v: number }>({
        initialData: { v: 1 },
        path: '/posts/opaque',
        editorOrigin: OPAQUE_URL,
      })
      return <button data-testid="report" onClick={() => reportError('boom')} />
    }
    const { getByTestId } = render(<Reporter />)
    ;(parentWin.postMessage as ReturnType<typeof vi.fn>).mockClear() // ignore READY handshake attempts
    fireEvent.click(getByTestId('report'))
    expect(parentWin.postMessage).not.toHaveBeenCalled()
  })
})

describe('PreviewLoadingState', () => {
  it('puts a boolean at each reference position, at the data’s own path', () => {
    type PersonFields = readonly [{ name: 'name'; type: 'string'; required: true }]
    type Post = TypeFromEntrySchema<
      readonly [
        { name: 'title'; type: 'string' },
        { name: 'author'; type: 'reference'; resolvedSchema: PersonFields },
        { name: 'editors'; type: 'reference'; list: true; resolvedSchema: PersonFields },
        {
          name: 'byline'
          type: 'object'
          fields: readonly [{ name: 'person'; type: 'reference'; resolvedSchema: PersonFields }]
        },
        {
          name: 'blocks'
          type: 'block'
          templates: readonly [
            {
              name: 'quote'
              fields: readonly [
                { name: 'speaker'; type: 'reference'; resolvedSchema: PersonFields },
              ]
            },
          ]
        },
      ]
    >
    type Loading = PreviewLoadingState<Post>

    expectTypeOf<Loading['author']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<Loading['editors']>().toEqualTypeOf<boolean[] | undefined>()
    expectTypeOf<NonNullable<Loading['byline']>['person']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<
      NonNullable<NonNullable<NonNullable<Loading['blocks']>[number]['value']>['speaker']>
    >().toEqualTypeOf<boolean>()
  })
})
