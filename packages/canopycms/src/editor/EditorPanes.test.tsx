import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import React from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { EditorPanes } from './EditorPanes'
import { CanopyCMSProvider } from './theme'

const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

beforeAll(() => {
  // Mantine helpers expect matchMedia/ResizeObserver to exist in the browser.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 1200,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    value: 800,
  })
})

afterAll(() => {
  if (originalWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth)
  }
  if (originalHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalHeight)
  }
})

afterEach(() => cleanup())

describe('EditorPanes split panes', () => {
  it('disables preview interactions while dragging the gutter', async () => {
    const { container, getByTestId } = render(
      <CanopyCMSProvider>
        <EditorPanes preview={<div>Preview area</div>} form={<div>Form area</div>} />
      </CanopyCMSProvider>,
    )

    const previewPane = getByTestId('preview-pane')
    await waitFor(() => expect(container.querySelector('.Resizer')).toBeTruthy())
    const resizer = container.querySelector('.Resizer') as HTMLElement

    expect(previewPane.style.pointerEvents).toBe('')

    fireEvent.mouseDown(resizer, { clientX: 200, clientY: 100, buttons: 1 })
    expect(previewPane.style.pointerEvents).toBe('none')

    fireEvent.mouseUp(resizer)
    await waitFor(() => expect(previewPane.style.pointerEvents).toBe(''))
  })

  const primaryPaneStyle = (getByTestId: (id: string) => HTMLElement) =>
    getByTestId('preview-pane').parentElement?.style

  it('sizes the primary pane from the controlled percent props', () => {
    const { getByTestId, rerender } = render(
      <CanopyCMSProvider>
        <EditorPanes sideSplitPercent={30} stackedSplitPercent={70} />
      </CanopyCMSProvider>,
    )
    expect(primaryPaneStyle(getByTestId)?.width).toBe('30%')

    rerender(
      <CanopyCMSProvider>
        <EditorPanes sideSplitPercent={40} stackedSplitPercent={70} />
      </CanopyCMSProvider>,
    )
    expect(primaryPaneStyle(getByTestId)?.width).toBe('40%')

    rerender(
      <CanopyCMSProvider>
        <EditorPanes layout="stacked" sideSplitPercent={40} stackedSplitPercent={70} />
      </CanopyCMSProvider>,
    )
    expect(primaryPaneStyle(getByTestId)?.height).toBe('70%')
  })

  it('defaults to 52% side and 58% stacked without the props', () => {
    const side = render(
      <CanopyCMSProvider>
        <EditorPanes />
      </CanopyCMSProvider>,
    )
    expect(primaryPaneStyle(side.getByTestId)?.width).toBe('52%')
    side.unmount()

    const stacked = render(
      <CanopyCMSProvider>
        <EditorPanes layout="stacked" />
      </CanopyCMSProvider>,
    )
    expect(primaryPaneStyle(stacked.getByTestId)?.height).toBe('58%')
  })

  it('reports the split only when a drag ends, with the clamped percent', async () => {
    const onSplitPercentChange = vi.fn()
    const { container } = render(
      <CanopyCMSProvider>
        <EditorPanes onSplitPercentChange={onSplitPercentChange} />
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(container.querySelector('.Resizer')).toBeTruthy())
    const resizer = container.querySelector('.Resizer') as HTMLElement

    fireEvent.mouseDown(resizer, { clientX: 600, clientY: 100, buttons: 1 })
    fireEvent.mouseMove(document, { clientX: 700, clientY: 100, buttons: 1 })
    expect(onSplitPercentChange).not.toHaveBeenCalled()

    fireEvent.mouseUp(document)
    await waitFor(() => expect(onSplitPercentChange).toHaveBeenCalledTimes(1))
    const [layout, percent] = onSplitPercentChange.mock.calls[0]
    expect(layout).toBe('side')
    expect(percent).toBeGreaterThanOrEqual(15)
    expect(percent).toBeLessThanOrEqual(85)
  })

  it('reports nothing when the gutter is clicked without dragging', async () => {
    const onSplitPercentChange = vi.fn()
    const { container, getByTestId } = render(
      <CanopyCMSProvider>
        <EditorPanes onSplitPercentChange={onSplitPercentChange} />
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(container.querySelector('.Resizer')).toBeTruthy())
    const resizer = container.querySelector('.Resizer') as HTMLElement

    fireEvent.mouseDown(resizer, { clientX: 600, clientY: 100, buttons: 1 })
    fireEvent.mouseUp(document)

    await waitFor(() => expect(getByTestId('preview-pane').style.pointerEvents).toBe(''))
    expect(onSplitPercentChange).not.toHaveBeenCalled()
    expect(getByTestId('preview-pane').parentElement?.style.width).toBe('52%')
  })
})
