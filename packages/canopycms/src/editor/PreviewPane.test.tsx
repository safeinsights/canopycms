import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useState } from 'react'

import type { PreviewWidth } from './hooks/useEditorLayout'
import {
  CANOPY_PREVIEW_MARKS,
  CANOPY_PREVIEW_MESSAGE,
  CANOPY_PREVIEW_READY,
} from './preview-bridge'
import { PreviewPane, type PreviewPaneProps } from './PreviewPane'
import { CanopyCMSProvider } from './theme'

const paneSize = vi.hoisted(() => ({ width: 0, height: 0 }))

vi.mock('@mantine/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/hooks')>()
  return {
    ...actual,
    useElementSize: () => ({ ref: { current: null }, ...paneSize }),
  }
})

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CanopyCMSProvider>{children}</CanopyCMSProvider>
)

const src = '/preview/posts/hello?branch=feature-a'

const renderPane = (
  props: {
    previewWidth?: PreviewWidth
    onPreviewWidthChange?: (w: PreviewWidth) => void
    onPreviewError?: (error: { message: string } | null) => void
    notice?: React.ReactNode
  } = {},
) => {
  const utils = render(
    <PreviewPane
      src={src}
      data={{ title: 'Draft' }}
      previewWidth={props.previewWidth ?? 'fit'}
      onPreviewWidthChange={props.onPreviewWidthChange ?? vi.fn()}
      onPreviewError={props.onPreviewError}
      notice={props.notice}
    />,
    { wrapper: Wrapper },
  )
  const iframe = () => utils.container.querySelector('iframe') as HTMLIFrameElement
  return { ...utils, iframe }
}

describe('PreviewPane', () => {
  beforeEach(() => {
    paneSize.width = 0
    paneSize.height = 0
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the page path without the branch query', () => {
    renderPane()
    expect(screen.getByRole('button', { name: 'Copy path /preview/posts/hello' })).toBeTruthy()
  })

  it('copies the path and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderPane()
    await userEvent.click(screen.getByRole('button', { name: /^Copy path/ }))
    expect(writeText).toHaveBeenCalledWith('/preview/posts/hello')
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((el) => el.textContent === 'Path copied')).toBe(
        true,
      ),
    )
  })

  it('renders "fit" at the pane size with no scaling', () => {
    paneSize.width = 900
    paneSize.height = 600
    const { iframe } = renderPane()
    expect(iframe().style.width).toBe('100%')
    expect(iframe().style.transform).toBe('')
    expect(screen.getByTestId('preview-width-readout').textContent).toBe('900 px')
  })

  it('renders a fixed width at its CSS width, scaled down to a narrower pane', () => {
    paneSize.width = 640
    paneSize.height = 400
    const { iframe } = renderPane({ previewWidth: 'desktop' })
    expect(iframe().style.width).toBe('1280px')
    expect(iframe().style.height).toBe('800px')
    expect(iframe().style.transform).toBe('scale(0.5)')
    expect(screen.getByTestId('preview-width-readout').textContent).toBe('1280 px at 50%')
  })

  it('reports a new width choice', async () => {
    const onPreviewWidthChange = vi.fn()
    renderPane({ onPreviewWidthChange })
    await userEvent.click(screen.getByRole('textbox', { name: 'Preview width' }))
    await userEvent.click(await screen.findByRole('option', { name: /Tablet/ }))
    expect(onPreviewWidthChange).toHaveBeenCalledWith('tablet')
  })

  it('reloads the preview with a fresh iframe and clears a reported error', async () => {
    const onPreviewError = vi.fn()
    const { iframe } = renderPane({ onPreviewError })
    const first = iframe()
    await userEvent.click(screen.getByRole('button', { name: 'Reload preview' }))
    expect(iframe()).not.toBe(first)
    expect(onPreviewError).toHaveBeenCalledWith(null)
  })

  it("serves the chip's Retry with the same reload", () => {
    vi.useFakeTimers()
    const { iframe } = renderPane()
    fireEvent.load(iframe())
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    // The pane remounts the whole frame; the frame's own retry would replace only the iframe.
    const frame = iframe().parentElement
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(iframe().parentElement).not.toBe(frame)
    expect(screen.queryByText('Live updates off')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload preview' }))
  })

  it('puts the notice between the toolbar and the preview, not over it', () => {
    const { iframe } = renderPane({ notice: <div role="alert">Preview error</div> })
    const notice = screen.getByRole('alert')
    expect(notice.contains(iframe())).toBe(false)
    expect(notice.parentElement?.contains(iframe())).toBe(true)
    expect(notice.parentElement?.contains(screen.getByTestId('preview-toolbar'))).toBe(true)
    expect(notice.closest('[data-testid="preview-toolbar"]')).toBeNull()
    expect(iframe().parentElement?.parentElement?.contains(notice)).toBe(false)
  })

  it('hands focus to the toolbar when the notice goes with the focus in it', () => {
    const { rerender } = renderPane({ notice: <button type="button">Close notice</button> })
    screen.getByRole('button', { name: 'Close notice' }).focus()
    rerender(
      <PreviewPane
        src={src}
        data={{ title: 'Draft' }}
        previewWidth="fit"
        onPreviewWidthChange={vi.fn()}
      />,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload preview' }))
  })

  it('leaves focus elsewhere alone when the notice goes', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const { rerender } = renderPane({ notice: <div role="alert">Preview error</div> })
    outside.focus()
    rerender(
      <PreviewPane
        src={src}
        data={{ title: 'Draft' }}
        previewWidth="fit"
        onPreviewWidthChange={vi.fn()}
      />,
    )
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('opens the saved version of the page in a new tab', () => {
    renderPane()
    const link = screen.getByRole('link', { name: 'Open saved version in a new tab' })
    expect(link.getAttribute('href')).toBe(src)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  describe('maximize', () => {
    // Holds `maximized` the way the editor does, so focus moves can be watched end to end.
    const Maximizable = (props: Partial<PreviewPaneProps>) => {
      const [maximized, setMaximized] = useState(false)
      return (
        <>
          <button type="button">Outside</button>
          <PreviewPane
            src={src}
            data={{ title: 'Draft' }}
            previewWidth="fit"
            onPreviewWidthChange={vi.fn()}
            maximized={maximized}
            onMaximizedChange={setMaximized}
            {...props}
          />
        </>
      )
    }
    const restoreButton = () => screen.queryByRole('button', { name: 'Restore' })

    it('moves focus to Restore on entering, and back to Maximize on restoring', async () => {
      render(<Maximizable />, { wrapper: Wrapper })
      const maximize = screen.getByRole('button', { name: 'Maximize preview' })
      act(() => maximize.focus())
      fireEvent.click(maximize)
      expect(document.activeElement).toBe(restoreButton())

      fireEvent.click(restoreButton()!)
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Maximize preview' }))
    })

    it('restores on Escape from inside the pane, or with focus nowhere', async () => {
      render(<Maximizable />, { wrapper: Wrapper })
      fireEvent.click(screen.getByRole('button', { name: 'Maximize preview' }))
      fireEvent.keyDown(restoreButton()!, { key: 'Escape' })
      expect(restoreButton()).toBeNull()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Maximize preview' }))

      fireEvent.click(screen.getByRole('button', { name: 'Maximize preview' }))
      act(() => (document.activeElement as HTMLElement).blur())
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(restoreButton()).toBeNull()
    })

    it('leaves Escape from outside the pane, or from an open dropdown, to them', async () => {
      render(<Maximizable />, { wrapper: Wrapper })
      fireEvent.click(screen.getByRole('button', { name: 'Maximize preview' }))

      fireEvent.keyDown(screen.getByRole('button', { name: 'Outside' }), { key: 'Escape' })
      expect(restoreButton()).toBeTruthy()

      const width = screen.getByRole('textbox', { name: 'Preview width' })
      await userEvent.click(width)
      await screen.findByRole('option', { name: /Tablet/ })
      fireEvent.keyDown(width, { key: 'Escape' })
      expect(restoreButton()).toBeTruthy()

      const cancelled = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      cancelled.preventDefault()
      act(() => {
        restoreButton()!.dispatchEvent(cancelled)
      })
      expect(restoreButton()).toBeTruthy()
    })

    it("restores on Escape from anywhere in the editor's window, but not from a field with text", () => {
      render(
        <div data-canopy-shell="">
          <button type="button" aria-expanded="true">
            Rail
          </button>
          <button type="button" aria-haspopup="menu" aria-expanded="true">
            Open menu
          </button>
          <input aria-label="Filter" />
          <Maximizable />
        </div>,
        { wrapper: Wrapper },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Maximize preview' }))
      const filter = screen.getByRole('textbox', { name: 'Filter' })
      fireEvent.change(filter, { target: { value: 'abc' } })
      fireEvent.keyDown(filter, { key: 'Escape' })
      expect(restoreButton()).toBeTruthy()

      fireEvent.keyDown(screen.getByRole('button', { name: 'Open menu' }), { key: 'Escape' })
      expect(restoreButton()).toBeTruthy()

      // A disclosure for a docked panel is no popup.
      fireEvent.keyDown(screen.getByRole('button', { name: 'Rail' }), { key: 'Escape' })
      expect(restoreButton()).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Maximize preview' }))
      fireEvent.change(filter, { target: { value: '' } })
      fireEvent.keyDown(filter, { key: 'Escape' })
      expect(restoreButton()).toBeNull()
    })
  })

  it('shows its width over the preview while the divider is dragged', () => {
    paneSize.width = 1024
    paneSize.height = 600
    const pane = (props: Partial<PreviewPaneProps>) => (
      <PreviewPane
        src={src}
        previewWidth="fit"
        onPreviewWidthChange={vi.fn()}
        layout="side"
        {...props}
      />
    )
    const readout = () => screen.queryByTestId('preview-resize-readout')
    const { rerender } = render(pane({}), { wrapper: Wrapper })
    expect(readout()).toBeNull()

    rerender(pane({ resizing: true }))
    expect(readout()?.textContent).toBe('1024 px')
    expect(readout()?.getAttribute('aria-hidden')).toBe('true')

    rerender(pane({ resizing: true, layout: 'stacked' }))
    expect(readout()?.textContent).toBe('1024 × 600 px')
  })

  it('counts unmapped marks for an admin only, and shows only the controls it is given', () => {
    const marks = [{ path: 'subtitle' }]
    const { rerender } = render(
      <PreviewPane
        src={src}
        previewWidth="fit"
        onPreviewWidthChange={vi.fn()}
        highlightEnabled
        inexactMarks={marks}
      />,
      { wrapper: Wrapper },
    )
    expect(screen.queryByTestId('preview-unmapped-chip')).toBeNull()
    for (const name of ['Highlight fields in the preview', 'Maximize preview']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    rerender(
      <PreviewPane
        src={src}
        previewWidth="fit"
        onPreviewWidthChange={vi.fn()}
        highlightEnabled
        inexactMarks={marks}
        showMarkDiagnostics
      />,
    )
    expect(screen.getByTestId('preview-unmapped-chip').textContent).toBe('1 unmapped preview mark')
  })

  describe('while the next entry loads', () => {
    const nextSrc = '/preview/posts/world?branch=feature-a'
    const pane = (props: Partial<PreviewPaneProps>) => (
      <PreviewPane
        src={src}
        data={{ title: 'Hello draft' }}
        previewWidth="fit"
        onPreviewWidthChange={vi.fn()}
        mount={{ previewPrefix: '/preview' }}
        {...props}
      />
    )
    const iframe = () => document.querySelector('iframe') as HTMLIFrameElement
    const sentDrafts = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls
        .map(([message]) => message as { type?: string; path?: string; data?: unknown })
        .filter((message) => message.type === CANOPY_PREVIEW_MESSAGE)
    const ready = (from: HTMLIFrameElement) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: CANOPY_PREVIEW_READY, path: from.getAttribute('src') },
            origin: window.location.origin,
            source: from.contentWindow,
          }),
        )
      })

    it('keeps the toolbar and the last page, dimmed, then frames the next with its own draft', () => {
      const { rerender } = render(pane({}), { wrapper: Wrapper })
      const toolbar = screen.getByTestId('preview-toolbar')
      const first = iframe()
      const firstPost = vi.spyOn(first.contentWindow as Window, 'postMessage')

      // Data handed over while pending is not the next entry's draft yet, so the held page gets none.
      rerender(pane({ src: nextSrc, data: { title: 'Not yet' }, pending: true }))
      expect(screen.getByTestId('preview-toolbar')).toBe(toolbar)
      expect(iframe()).toBe(first)
      expect(first.getAttribute('src')).toBe(src)
      expect(first.hasAttribute('inert')).toBe(true)
      expect(first.parentElement?.getAttribute('aria-busy')).toBe('true')
      expect(screen.getByRole('progressbar', { name: 'Loading the entry' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Copy path /posts/world' })).toBeTruthy()
      ready(first)
      expect(sentDrafts(firstPost)).toEqual([])

      rerender(pane({ src: nextSrc, data: { title: 'World draft' } }))
      expect(screen.getByTestId('preview-toolbar')).toBe(toolbar)
      const next = iframe()
      expect(next).not.toBe(first)
      expect(next.getAttribute('src')).toBe(nextSrc)
      expect(next.hasAttribute('inert')).toBe(false)
      expect(screen.queryByRole('progressbar', { name: 'Loading the entry' })).toBeNull()
      const nextPost = vi.spyOn(next.contentWindow as Window, 'postMessage')
      ready(next)
      expect(sentDrafts(nextPost)).toEqual([
        expect.objectContaining({ path: nextSrc, data: { title: 'World draft' } }),
      ])
      expect(sentDrafts(firstPost)).toEqual([])
    })

    it('reports no marks from the page it holds', () => {
      const onMarks = vi.fn()
      const { rerender } = render(pane({ onMarks }), { wrapper: Wrapper })
      const first = iframe()
      rerender(pane({ src: nextSrc, data: undefined, pending: true, onMarks }))
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: CANOPY_PREVIEW_MARKS, count: 0 },
            origin: window.location.origin,
            source: first.contentWindow,
          }),
        )
      })
      expect(onMarks).not.toHaveBeenCalled()
    })

    it('holds a skeleton under the toolbar when no page has been framed yet', () => {
      render(pane({ data: undefined, pending: true }), { wrapper: Wrapper })
      expect(screen.getByTestId('preview-toolbar')).toBeTruthy()
      expect(screen.getByTestId('preview-loading-skeleton')).toBeTruthy()
      expect(iframe()).toBeNull()
    })
  })

  describe('the site header and footer', () => {
    const pane = (props: Partial<PreviewPaneProps>) => (
      <PreviewPane
        src={src}
        data={{ title: 'Draft' }}
        previewWidth="fit"
        onPreviewWidthChange={vi.fn()}
        mount={{ previewPrefix: '/preview' }}
        onSiteChromeChange={vi.fn()}
        {...props}
      />
    )
    const toggle = () => screen.queryByRole('button', { name: 'Site header and footer' })
    const sayReady = (siteChrome?: boolean) => {
      const frame = document.querySelector('iframe') as HTMLIFrameElement
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: CANOPY_PREVIEW_READY,
              path: frame.getAttribute('src'),
              ...(siteChrome === undefined ? {} : { siteChrome }),
            },
            origin: window.location.origin,
            source: frame.contentWindow,
          }),
        )
      })
    }

    it('offers the toggle once the page says it renders them', async () => {
      const onSiteChromeChange = vi.fn()
      render(pane({ onSiteChromeChange }), { wrapper: Wrapper })
      expect(toggle()).toBeNull()
      sayReady(true)
      expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
      await userEvent.click(toggle() as HTMLElement)
      expect(onSiteChromeChange).toHaveBeenCalledWith(true)
    })

    it('offers no toggle when the page says nothing of them', () => {
      render(pane({}), { wrapper: Wrapper })
      sayReady()
      expect(toggle()).toBeNull()
    })

    it("offers no toggle for a page outside the preview mount, which is the site's own", () => {
      render(pane({ src: '/posts/hello?branch=feature-a', siteChrome: true }), {
        wrapper: Wrapper,
      })
      sayReady(true)
      expect(toggle()).toBeNull()
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
        '/posts/hello?branch=feature-a',
      )
    })

    it('frames and opens the page with chrome=1 while on, and shows its path without it', () => {
      render(pane({ siteChrome: true }), { wrapper: Wrapper })
      sayReady(true)
      const chromeSrc = '/preview/posts/hello?branch=feature-a&chrome=1'
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(chromeSrc)
      expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
      expect(
        screen.getByRole('link', { name: 'Open saved version in a new tab' }).getAttribute('href'),
      ).toBe(chromeSrc)
      expect(screen.getByRole('button', { name: 'Copy path /posts/hello' })).toBeTruthy()
    })
  })
})
