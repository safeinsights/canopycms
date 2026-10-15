import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { PaneLayout, type PaneLayoutProps } from './PaneLayout'
import { CanopyCMSProvider } from '../theme'

const originalRect = HTMLElement.prototype.getBoundingClientRect
const originalResizeObserver = window.ResizeObserver
const sizeProps = ['offsetWidth', 'offsetHeight'] as const
const originalSizes = sizeProps.map((prop) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop),
)

// jsdom lays nothing out, and the library measures its group before it applies a layout.
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1000 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 800 })
  window.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const rect = target.getBoundingClientRect()
      const size = [{ inlineSize: rect.width, blockSize: rect.height }]
      const entry = { target, contentRect: rect, borderBoxSize: size, contentBoxSize: size }
      this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  }
})

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect
  window.ResizeObserver = originalResizeObserver
  sizeProps.forEach((prop, i) => {
    const descriptor = originalSizes[i]
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
  })
})

afterEach(() => cleanup())

const renderPanes = (props: Partial<PaneLayoutProps> = {}) => {
  const ui = (p: Partial<PaneLayoutProps>) => (
    <CanopyCMSProvider>
      <PaneLayout
        arrangement="side"
        preview={<iframe title="Preview" />}
        form={<div>Form</div>}
        {...props}
        {...p}
      />
    </CanopyCMSProvider>
  )
  const view = render(ui({}))
  return { ...view, rerenderPanes: (next: Partial<PaneLayoutProps>) => view.rerender(ui(next)) }
}

// The library sizes each panel by its flex-grow, in percent.
const previewShare = () => screen.getByTestId('preview-pane').closest('[data-panel]') as HTMLElement
const separator = () => screen.getByRole('separator', { name: 'Resize preview and form' })

describe('PaneLayout', () => {
  it('sizes the preview from the percent for its arrangement', () => {
    const { rerenderPanes } = renderPanes({ sideSplitPercent: 30, stackedSplitPercent: 70 })
    expect(previewShare().style.flexGrow).toBe('30')
    expect(separator().getAttribute('aria-orientation')).toBe('vertical')

    rerenderPanes({ arrangement: 'stacked' })
    expect(previewShare().style.flexGrow).toBe('70')
    expect(separator().getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('defaults to 52% beside the form and 58% above it', () => {
    const { rerenderPanes } = renderPanes()
    expect(previewShare().style.flexGrow).toBe('52')
    rerenderPanes({ arrangement: 'stacked' })
    expect(previewShare().style.flexGrow).toBe('58')
  })

  it('follows a percent that arrives after mount, without remounting the preview', () => {
    const { rerenderPanes } = renderPanes()
    const iframe = screen.getByTitle('Preview')

    rerenderPanes({ sideSplitPercent: 35 })
    expect(previewShare().style.flexGrow).toBe('35')
    rerenderPanes({ sideSplitPercent: 35, arrangement: 'stacked' })
    expect(screen.getByTitle('Preview')).toBe(iframe)
  })

  it('makes the split a focusable separator naming the preview it resizes', () => {
    renderPanes()
    expect(separator().tabIndex).toBe(0)
    expect(separator().getAttribute('aria-controls')).toBe(previewShare().id)
  })

  it('reports a resize the user makes, and not one a prop makes', () => {
    const onSplitPercentChange = vi.fn()
    const { rerenderPanes } = renderPanes({ onSplitPercentChange })
    rerenderPanes({ sideSplitPercent: 40 })
    expect(onSplitPercentChange).not.toHaveBeenCalled()

    act(() => {
      fireEvent.keyDown(separator(), { key: 'ArrowRight' })
    })
    expect(onSplitPercentChange).toHaveBeenCalledTimes(1)
    const [arrangement, percent] = onSplitPercentChange.mock.calls[0]
    expect(arrangement).toBe('side')
    expect(percent).toBeGreaterThan(40)
  })

  it('stops the panes taking the pointer while the separator is held', async () => {
    renderPanes()
    const panes = [screen.getByTestId('preview-pane'), screen.getByTestId('form-pane')]

    act(() => separator().setAttribute('data-separator', 'active'))
    await waitFor(() => panes.forEach((pane) => expect(pane.style.pointerEvents).toBe('none')))

    act(() => separator().setAttribute('data-separator', 'hover'))
    await waitFor(() => panes.forEach((pane) => expect(pane.style.pointerEvents).toBe('')))
  })
})
