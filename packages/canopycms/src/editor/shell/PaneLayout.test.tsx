import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'

import { DIVIDER_COLOR, DIVIDER_WIDTH_PX } from './EditorShell'
import {
  PaneLayout,
  SPLIT_PERCENT_MAX,
  SPLIT_PERCENT_MIN,
  type PaneLayoutProps,
} from './PaneLayout'
import { SidePanelHost } from './SidePanelHost'
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
    private targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {
      observers.add(this)
    }
    observe(target: Element) {
      this.targets.add(target)
      this.fire([target])
    }
    unobserve(target: Element) {
      this.targets.delete(target)
    }
    disconnect() {
      this.targets.clear()
      observers.delete(this)
    }
    fire(targets: Iterable<Element> = this.targets) {
      const entries = [...targets].map((target) => {
        const rect = target.getBoundingClientRect()
        const size = [{ inlineSize: rect.width, blockSize: rect.height }]
        return { target, contentRect: rect, borderBoxSize: size, contentBoxSize: size }
      })
      this.callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
    }
  }
})

/** Every live ResizeObserver in the stub, so a test can report a resize jsdom never computes. */
const observers = new Set<{ fire: () => void }>()
const fireResizeObservers = () => act(() => observers.forEach((observer) => observer.fire()))

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

  it('reports a held separator once it moves the split, and once as it is let go', async () => {
    const onSeparatorDrag = vi.fn()
    renderPanes({ onSeparatorDrag })
    const grab = () => act(() => separator().setAttribute('data-separator', 'active'))
    const letGo = () => act(() => separator().setAttribute('data-separator', 'hover'))
    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

    // A press alone, as a click that only focuses the separator is, reports nothing.
    grab()
    await settle()
    letGo()
    await settle()
    expect(onSeparatorDrag).not.toHaveBeenCalled()

    grab()
    await settle()
    act(() => fireEvent.keyDown(separator(), { key: 'ArrowRight' }))
    act(() => fireEvent.keyDown(separator(), { key: 'ArrowRight' }))
    expect(onSeparatorDrag.mock.calls).toEqual([[true]])
    letGo()
    await waitFor(() => expect(onSeparatorDrag.mock.calls).toEqual([[true], [false]]))
  })

  it('takes no resize while the preview is maximized', () => {
    const onSplitPercentChange = vi.fn()
    renderPanes({ previewMaximized: true, onSplitPercentChange })
    act(() => fireEvent.keyDown(separator(), { key: 'ArrowRight' }))
    expect(onSplitPercentChange).not.toHaveBeenCalled()
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
    // Its own stacking context, so no z-index inside it can lift the overlay over the preview.
    expect(formPanel.style.isolation).toBe('isolate')

    rerenderPanes({ formOverlay: <button type="button">Panel</button> })
    expect(screen.getByTestId('preview-pane').style.position).toBe('')
    expect(formPanel.hasAttribute('inert')).toBe(false)
    expect(separator().hasAttribute('inert')).toBe(false)
  })

  describe('formAside', () => {
    const contentPanel = (
      <SidePanelHost
        title="Content"
        mode="docked"
        opened
        width={280}
        minWidth={240}
        maxWidth={400}
        onWidthChange={() => {}}
        onClose={() => {}}
      >
        <button type="button">In the tree</button>
      </SidePanelHost>
    )
    const aside = () => screen.getByTestId('form-aside')

    /** Measures the form row from `measured.top` down, and the aside's width probe `measured.width` wide. */
    const stubFormRowLayout = (measured = { top: 450, width: 280 }) => {
      const stubbed = HTMLElement.prototype.getBoundingClientRect
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this.firstElementChild?.getAttribute('data-testid') === 'form-pane') {
          return new DOMRect(0, measured.top, 1000, 800 - measured.top)
        }
        if (this.parentElement?.dataset.testid === 'form-aside' && this.ariaHidden === 'true') {
          return new DOMRect(0, measured.top, measured.width, 0)
        }
        return stubbed.call(this)
      }
      onTestFinished(() => {
        HTMLElement.prototype.getBoundingClientRect = stubbed
      })
      return measured
    }
    const layoutVar = (name: string) =>
      (aside().parentElement as HTMLElement).style.getPropertyValue(name)
    const formPanel = () => screen.getByTestId('form-pane').parentElement as HTMLElement

    it('docks beside the form in its row, leaving the preview its full row', () => {
      stubFormRowLayout()
      renderPanes({ arrangement: 'stacked', formAside: contentPanel })
      expect(previewShare().contains(aside())).toBe(false)
      // Placed at the form row's measured top, with the form starting at its measured width.
      expect(layoutVar('--canopy-form-aside-top')).toBe('450px')
      expect(aside().style.top).toBe('var(--canopy-form-aside-top, 0px)')
      expect(layoutVar('--canopy-form-aside-width')).toBe('280px')
      expect(formPanel().style.marginInlineStart).toBe('var(--canopy-form-aside-width, 0px)')
      expect(screen.getByTestId('form-pane').closest('[inert]')).toBeNull()
    })

    it('follows the form row and its own width as they resize', () => {
      const measured = stubFormRowLayout()
      renderPanes({ arrangement: 'stacked', formAside: contentPanel })
      measured.top = 300
      measured.width = 360
      fireResizeObservers()
      expect(layoutVar('--canopy-form-aside-top')).toBe('300px')
      expect(layoutVar('--canopy-form-aside-width')).toBe('360px')
    })

    it("comes before the panes in focus order, as the side layout's panel column does", () => {
      const { rerenderPanes } = renderPanes({ arrangement: 'stacked', formAside: contentPanel })
      const tree = screen.getByRole('button', { name: 'In the tree' })
      const follows = (element: Element) =>
        Boolean(tree.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
      expect(follows(screen.getByTitle('Preview'))).toBe(true)
      expect(follows(separator())).toBe(true)

      rerenderPanes({ arrangement: 'stacked', formAside: contentPanel, previewMaximized: true })
      expect(follows(screen.getByTitle('Preview'))).toBe(true)
    })

    it('is left out in the side arrangement', () => {
      renderPanes({ arrangement: 'side', formAside: contentPanel })
      expect(screen.queryByTestId('form-aside')).toBeNull()
      expect(formPanel().style.marginInlineStart).toBe('')
    })

    it("stays beside a maximized preview, the layout's full height, and out of its inert", () => {
      const { rerenderPanes } = renderPanes({ arrangement: 'stacked', formAside: contentPanel })
      expect(aside().hasAttribute('data-lifted')).toBe(false)

      rerenderPanes({ arrangement: 'stacked', formAside: contentPanel, previewMaximized: true })
      expect(aside().hasAttribute('data-lifted')).toBe(true)
      expect(aside().style.top).toBe('0px')
      expect(aside().closest('[inert]')).toBeNull()
      expect(screen.getByRole('button', { name: 'In the tree' }).closest('[inert]')).toBeNull()
      const preview = screen.getByTestId('preview-pane')
      expect(preview.style.insetInlineStart).toBe('var(--canopy-form-aside-width, 0px)')
      // Its insets size it: a set width would run it past the layout's end.
      expect(preview.style.width).toBe('')
      expect(screen.getByTestId('form-pane').closest('[inert]')).not.toBeNull()
      // Over the preview, whose stacking would otherwise cover its separator's outer edge.
      expect(Number(aside().style.zIndex)).toBeGreaterThan(Number(preview.style.zIndex))
    })

    it("draws its separator as the panel's, at the shared divider width", () => {
      renderPanes({ arrangement: 'stacked', formAside: contentPanel })
      const panes = getComputedStyle(separator())
      const panel = getComputedStyle(
        screen.getByRole('separator', { name: 'Resize content panel' }),
      )
      expect(panes.minHeight).toBe(`${DIVIDER_WIDTH_PX}px`)
      expect(panel.width).toBe(`${DIVIDER_WIDTH_PX}px`)
      expect(panes.getPropertyValue('background')).toBe(DIVIDER_COLOR)
      expect(panel.getPropertyValue('background')).toBe(DIVIDER_COLOR)
    })

    it('lifts the separator over the panes, and colours it only while focus is visible', () => {
      renderPanes({ arrangement: 'stacked', formAside: contentPanel })
      const background = () => getComputedStyle(separator()).getPropertyValue('background')
      expect(getComputedStyle(separator()).position).toBe('relative')
      expect(getComputedStyle(separator()).zIndex).toBe('1')
      // The library marks a separator 'focus' on any press; a click alone leaves it uncoloured.
      act(() => separator().setAttribute('data-separator', 'focus'))
      expect(background()).toBe(DIVIDER_COLOR)
      act(() => separator().focus())
      expect(separator().matches(':focus-visible')).toBe(true)
      expect(background()).toBe('var(--canopy-focus-ring)')
    })
  })
})
