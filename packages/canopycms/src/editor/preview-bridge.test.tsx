import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CANOPY_PREVIEW_ERROR,
  CANOPY_PREVIEW_FOCUS,
  CANOPY_PREVIEW_HIGHLIGHT,
  CANOPY_PREVIEW_MESSAGE,
  CANOPY_PREVIEW_READY,
  isTrustedEditorMessage,
  PreviewFrame,
  resolveMessageOrigin,
  useCanopyPreview,
} from './preview-bridge'

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
})
