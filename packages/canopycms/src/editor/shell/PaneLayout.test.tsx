import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  PaneLayout,
  SPLIT_PERCENT_MAX,
  SPLIT_PERCENT_MIN,
  type PaneLayoutProps,
} from './PaneLayout'
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

  it('holds a resize to the stored range, on screen as in what it reports', () => {
    const onSplitPercentChange = vi.fn()
    renderPanes({ sideSplitPercent: 80, onSplitPercentChange })

    for (let i = 0; i < 4; i++) act(() => fireEvent.keyDown(separator(), { key: 'ArrowRight' }))
    expect(onSplitPercentChange).toHaveBeenLastCalledWith('side', SPLIT_PERCENT_MAX)
    expect(previewShare().style.flexGrow).toBe(String(SPLIT_PERCENT_MAX))
    expect(separator().getAttribute('aria-valuemin')).toBe(String(SPLIT_PERCENT_MIN))
    expect(separator().getAttribute('aria-valuemax')).toBe(String(SPLIT_PERCENT_MAX))
  })

  it('reports a held separator once as it is grabbed and once as it is let go', async () => {
    const onSeparatorDrag = vi.fn()
    renderPanes({ onSeparatorDrag })

    act(() => separator().setAttribute('data-separator', 'hover'))
    act(() => separator().setAttribute('data-separator', 'active'))
    await waitFor(() => expect(onSeparatorDrag).toHaveBeenCalledWith(true))
    act(() => separator().setAttribute('data-separator', 'hover'))
    await waitFor(() => expect(onSeparatorDrag).toHaveBeenLastCalledWith(false))
    act(() => separator().setAttribute('data-separator', 'inactive'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSeparatorDrag.mock.calls).toEqual([[true], [false]])
  })

  it('lays a maximized preview over the form, which goes inert, without remounting it', () => {
    const { rerenderPanes } = renderPanes({ formOverlay: <button type="button">Panel</button> })
    const frame = screen.getByTitle('Preview')
    const formPanel = screen.getByTestId('form-pane').parentElement as HTMLElement
    expect(formPanel.hasAttribute('inert')).toBe(false)

    rerenderPanes({ formOverlay: <button type="button">Panel</button>, previewMaximized: true })
    const preview = screen.getByTestId('preview-pane')
    expect(preview.style.position).toBe('absolute')
    expect(preview.style.inset).toBe('0')
    expect(screen.getByTitle('Preview')).toBe(frame)
    // The form and the overlay over it both sit under the preview, out of the Tab order.
    expect(formPanel.hasAttribute('inert')).toBe(true)
    expect(formPanel.contains(screen.getByRole('button', { name: 'Panel', hidden: true }))).toBe(
      true,
    )
    expect(separator().hasAttribute('inert')).toBe(true)

    rerenderPanes({ formOverlay: <button type="button">Panel</button> })
    expect(screen.getByTestId('preview-pane').style.position).toBe('')
    expect(formPanel.hasAttribute('inert')).toBe(false)
    expect(separator().hasAttribute('inert')).toBe(false)
  })
})
