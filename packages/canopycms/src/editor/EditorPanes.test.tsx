import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import React from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

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

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 800 })
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
})
