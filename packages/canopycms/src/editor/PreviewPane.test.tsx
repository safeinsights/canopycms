import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewWidth } from './hooks/useEditorLayout'
import { PreviewPane } from './PreviewPane'
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

  it('opens the saved version of the page in a new tab', () => {
    renderPane()
    const link = screen.getByRole('link', { name: 'Open saved version in a new tab' })
    expect(link.getAttribute('href')).toBe(src)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
