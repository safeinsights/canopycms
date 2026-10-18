import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'

import { SidePanelHost, type SidePanelHostProps } from './SidePanelHost'
import { CanopyCMSProvider } from '../theme'
import { FOCUS_RETURN_ATTR } from '../utils/focus-return'

// jsdom has no PointerEvent, so a fired pointer event would carry no button or position.
const originalPointerEvent = window.PointerEvent
beforeAll(() => {
  window.PointerEvent = class extends MouseEvent {
    readonly pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  } as typeof PointerEvent
})
afterAll(() => {
  window.PointerEvent = originalPointerEvent
})

const originalMatchMedia = window.matchMedia
afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-canopy-panel-resizing')
  window.matchMedia = originalMatchMedia
})

/** The user's motion preference, as `prefers-reduced-motion` reports it. */
const stubReducedMotion = () => {
  window.matchMedia = (query: string) =>
    ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

const baseProps = (): SidePanelHostProps => ({
  title: 'Content',
  mode: 'docked',
  opened: true,
  width: 280,
  minWidth: 240,
  maxWidth: 400,
  onWidthChange: vi.fn(),
  onClose: vi.fn(),
  children: <button>Inside</button>,
})

const renderPanel = (props: Partial<SidePanelHostProps> = {}) => {
  const all = { ...baseProps(), ...props }
  const result = render(<SidePanelHost {...all} />, { wrapper: CanopyCMSProvider })
  return { ...result, props: all }
}

const separator = () => screen.getByRole('separator', { name: 'Resize content panel' })

/** A toggle that opens and closes the panel, as the rail's Content button does. */
function Harness({
  initiallyOpen = false,
  mode = 'docked',
}: {
  initiallyOpen?: boolean
  mode?: SidePanelHostProps['mode']
}) {
  const [opened, setOpened] = useState(initiallyOpen)
  const [focusRequest, setFocusRequest] = useState(0)
  const toggle = useRef<HTMLButtonElement>(null)
  return (
    <CanopyCMSProvider>
      <button
        ref={toggle}
        onClick={() => {
          if (!opened) setFocusRequest((request) => request + 1)
          setOpened((open) => !open)
        }}
      >
        Toggle
      </button>
      <button onClick={() => setOpened(true)}>Open quietly</button>
      <button onClick={() => setFocusRequest((request) => request + 1)}>Ask again</button>
      <SidePanelHost
        {...baseProps()}
        mode={mode}
        opened={opened}
        focusRequest={focusRequest}
        onClose={() => setOpened(false)}
        returnFocusTo={() => toggle.current}
      />
    </CanopyCMSProvider>
  )
}

describe('SidePanelHost', () => {
  it('renders nothing while closed', () => {
    renderPanel({ opened: false })
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('is a region named by its title, at its stored width, with a close button', () => {
    const { props } = renderPanel()
    const panel = screen.getByRole('region', { name: 'Content' })
    expect(panel.style.width).toBe('280px')
    fireEvent.click(screen.getByRole('button', { name: 'Close content panel' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the stored width inside its limits', () => {
    renderPanel({ width: 900 })
    expect(screen.getByRole('region').style.width).toBe('400px')
    expect(separator().getAttribute('aria-valuenow')).toBe('400')
  })

  describe('focus', () => {
    it('takes focus when asked to open, and returns it to the opener when it closes', () => {
      render(<Harness />)
      const toggle = screen.getByRole('button', { name: 'Toggle' })
      act(() => toggle.focus())
      fireEvent.click(toggle)
      const panel = screen.getByRole('region', { name: 'Content' })
      expect(document.activeElement).toBe(panel)

      act(() => screen.getByRole('button', { name: 'Inside' }).focus())
      fireEvent.click(screen.getByRole('button', { name: 'Close content panel' }))
      expect(document.activeElement).toBe(toggle)
    })

    it('takes focus again when asked while open, but not when it opens unasked', () => {
      render(<Harness />)
      fireEvent.click(screen.getByRole('button', { name: 'Open quietly' }))
      expect(screen.getByRole('region', { name: 'Content' })).toBeDefined()
      expect(document.activeElement).toBe(document.body)

      fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Content' }))
    })

    it('focuses its data-autofocus element when asked', () => {
      const { rerender, props } = renderPanel({ opened: false })
      rerender(
        <SidePanelHost {...props} opened focusRequest={1}>
          <input aria-label="Filter" data-autofocus />
        </SidePanelHost>,
      )
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter' }))
    })

    it('hands focus to a data-autofocus element that renders after it was asked', async () => {
      const { rerender, props } = renderPanel({ opened: false })
      rerender(<SidePanelHost {...props} opened focusRequest={1} />)
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Content' }))

      rerender(
        <SidePanelHost {...props} opened focusRequest={1}>
          <input aria-label="Filter" data-autofocus />
        </SidePanelHost>,
      )
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter' })),
      )
    })

    it('leaves a late data-autofocus element alone once focus has moved on', async () => {
      const { rerender, props } = renderPanel({ opened: false })
      rerender(
        <SidePanelHost {...props} opened focusRequest={1}>
          <button>Inside</button>
        </SidePanelHost>,
      )
      act(() => screen.getByRole('button', { name: 'Inside' }).focus())
      rerender(
        <SidePanelHost {...props} opened focusRequest={1}>
          <button>Inside</button>
          <input aria-label="Filter" data-autofocus />
        </SidePanelHost>,
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }))
    })

    it('leaves focus alone when it is open on mount, or closes without focus inside', () => {
      render(<Harness initiallyOpen />)
      expect(document.activeElement).toBe(document.body)

      const toggle = screen.getByRole('button', { name: 'Toggle' })
      fireEvent.click(toggle)
      expect(screen.queryByRole('region')).toBeNull()
      expect(document.activeElement).toBe(document.body)
    })
  })

  describe('focus leaving', () => {
    /** A panel with a portaled menu inside it, as a row's "…" menu is, and a button outside. */
    const renderWithPortal = (onFocusLeave: (target: Element) => void) =>
      render(
        <CanopyCMSProvider>
          <button>Outside</button>
          <SidePanelHost {...baseProps()} onFocusLeave={onFocusLeave}>
            <button>Inside</button>
            {createPortal(<button>Portaled</button>, document.body)}
          </SidePanelHost>
        </CanopyCMSProvider>,
      )
    const button = (name: string) => screen.getByRole('button', { name })
    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)))

    it('reports focus moving outside the panel, with where it went', async () => {
      const onFocusLeave = vi.fn()
      renderWithPortal(onFocusLeave)
      act(() => button('Inside').focus())

      act(() => button('Outside').focus())
      await settle()

      expect(onFocusLeave).toHaveBeenCalledTimes(1)
      expect(onFocusLeave).toHaveBeenCalledWith(button('Outside'))
    })

    it('counts what the panel portals, and moves within the panel, as inside', async () => {
      const onFocusLeave = vi.fn()
      renderWithPortal(onFocusLeave)
      act(() => button('Inside').focus())

      act(() => button('Portaled').focus())
      await settle()
      expect(onFocusLeave).not.toHaveBeenCalled()
      act(() => screen.getByRole('button', { name: 'Close content panel' }).focus())
      act(() => button('Inside').focus())
      await settle()

      expect(onFocusLeave).not.toHaveBeenCalled()
    })

    it('does not count focus dropping to nothing as leaving', async () => {
      const onFocusLeave = vi.fn()
      renderWithPortal(onFocusLeave)
      act(() => button('Inside').focus())

      act(() => button('Inside').blur())
      await settle()

      expect(onFocusLeave).not.toHaveBeenCalled()
    })

    it('reports focus landing outside after first dropping to nothing', async () => {
      const onFocusLeave = vi.fn()
      renderWithPortal(onFocusLeave)
      act(() => button('Inside').focus())
      act(() => button('Inside').blur())
      await settle()

      act(() => button('Outside').focus())
      await settle()

      expect(onFocusLeave).toHaveBeenCalledWith(button('Outside'))
    })

    it('reports focus moving into a frame outside the panel', async () => {
      const onFocusLeave = vi.fn()
      renderWithPortal(onFocusLeave)
      const frame = document.body.appendChild(document.createElement('iframe'))
      onTestFinished(() => frame.remove())
      act(() => button('Inside').focus())

      // Focus inside a frame shows in this document as the frame being active, and a window blur.
      vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame)
      act(() => {
        window.dispatchEvent(new FocusEvent('blur'))
      })
      await settle()
      vi.restoreAllMocks()
      // The press in the frame may still be held, so it waits for the pointer to come back.
      expect(onFocusLeave).not.toHaveBeenCalled()

      fireEvent.pointerMove(document.body, { buttons: 0 })
      await settle()

      expect(onFocusLeave).toHaveBeenCalledWith(frame)
    })

    it('waits for a press that moved focus outside to be released, so its click lands first', async () => {
      const onFocusLeave = vi.fn()
      renderWithPortal(onFocusLeave)
      act(() => button('Inside').focus())

      fireEvent.pointerDown(button('Outside'), { button: 0, buttons: 1 })
      act(() => button('Outside').focus())
      await settle()
      expect(onFocusLeave).not.toHaveBeenCalled()

      const clicked = vi.fn()
      button('Outside').addEventListener('click', clicked)
      fireEvent.pointerUp(button('Outside'), { button: 0 })
      fireEvent.click(button('Outside'))
      expect(onFocusLeave).not.toHaveBeenCalled()
      await settle()

      expect(clicked).toHaveBeenCalledTimes(1)
      expect(onFocusLeave).toHaveBeenCalledWith(button('Outside'))
    })

    it('counts a press released outside the window as released at its next move', async () => {
      const onFocusLeave = vi.fn()
      renderWithPortal(onFocusLeave)
      act(() => button('Inside').focus())
      fireEvent.pointerDown(button('Outside'), { button: 0, buttons: 1 })
      act(() => button('Outside').focus())

      fireEvent.pointerMove(document.body, { buttons: 1 })
      await settle()
      expect(onFocusLeave).not.toHaveBeenCalled()
      fireEvent.pointerMove(document.body, { buttons: 0 })
      await settle()

      expect(onFocusLeave).toHaveBeenCalledWith(button('Outside'))
    })
  })

  describe('motion', () => {
    const region = () => screen.queryByRole('region', { name: 'Content' })

    it('slides an overlay in, then out inert, handing focus back before it unmounts', async () => {
      render(<Harness mode="overlay" />)
      const toggle = screen.getByRole('button', { name: 'Toggle' })
      act(() => toggle.focus())
      fireEvent.click(toggle)
      await waitFor(() => expect(document.activeElement).toBe(region()))
      expect(region()?.style.transitionDuration).toBe('250ms')

      act(() => screen.getByRole('button', { name: 'Inside' }).focus())
      fireEvent.click(screen.getByRole('button', { name: 'Close content panel' }))
      // Still sliding out, it can neither keep focus nor take a click meant for the form.
      expect(region()?.hasAttribute('inert')).toBe(true)
      expect(region()?.hasAttribute(FOCUS_RETURN_ATTR)).toBe(true)
      expect(document.activeElement).toBe(toggle)
      await waitFor(() => expect(region()).toBeNull())
    })

    it('keeps the same section when reopened mid-slide, live again and taking focus', async () => {
      render(<Harness mode="overlay" />)
      const toggle = screen.getByRole('button', { name: 'Toggle' })
      act(() => toggle.focus())
      fireEvent.click(toggle)
      await waitFor(() => expect(document.activeElement).toBe(region()))
      const section = region()

      fireEvent.click(screen.getByRole('button', { name: 'Close content panel' }))
      expect(region()).toBe(section)
      expect(section?.hasAttribute('inert')).toBe(true)

      fireEvent.click(toggle)
      expect(region()).toBe(section)
      expect(section?.hasAttribute('inert')).toBe(false)
      expect(section?.hasAttribute(FOCUS_RETURN_ATTR)).toBe(false)
      await waitFor(() => expect(document.activeElement).toBe(section))
    })

    it.each([
      ['left to right', 'ltr', 'translateX(-100%)'],
      ['right to left', 'rtl', 'translateX(100%)'],
    ])('slides out toward the inline start, %s', async (_how, dir, out) => {
      // jsdom computes no `direction`, so the page's is stubbed from the nearest `dir`.
      const computed = window.getComputedStyle
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const style = computed(element, pseudo)
        const direction = element.closest('[dir]')?.getAttribute('dir') ?? 'ltr'
        return new Proxy(style, {
          get: (target, key) => {
            if (key === 'direction') return direction
            const value: unknown = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      })
      onTestFinished(() => {
        vi.restoreAllMocks()
      })
      render(
        <div dir={dir}>
          <Harness mode="overlay" />
        </div>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
      await waitFor(() => expect(region()).not.toBeNull())
      fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
      await waitFor(() => expect(region()?.style.transform).toBe(out))
    })

    it('opens and closes a docked panel at once, with no slide', () => {
      render(<Harness mode="docked" />)
      fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
      expect(region()?.style.transform).toBe('')
      fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
      expect(region()).toBeNull()
    })

    it('opens and closes an overlay at once when the user prefers reduced motion', async () => {
      stubReducedMotion()
      render(<Harness mode="overlay" />)
      // The preference arrives in an effect after the first render.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
      fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
      expect(region()?.style.transform).toBe('')
      fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
      expect(region()).toBeNull()
    })
  })

  describe('Escape', () => {
    it('closes an overlay', () => {
      const { props } = renderPanel({ mode: 'overlay' })
      fireEvent.keyDown(screen.getByRole('button', { name: 'Inside' }), { key: 'Escape' })
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })

    it('leaves a docked panel open', () => {
      const { props } = renderPanel({ mode: 'docked' })
      fireEvent.keyDown(screen.getByRole('button', { name: 'Inside' }), { key: 'Escape' })
      expect(props.onClose).not.toHaveBeenCalled()
    })

    it('is left to a dialog portalled from the panel', () => {
      const { props } = renderPanel({
        mode: 'overlay',
        children: <PortalledInput />,
      })
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'In a dialog' }), { key: 'Escape' })
      expect(props.onClose).not.toHaveBeenCalled()
    })
  })

  describe('resizing', () => {
    it('resizes by keyboard, within its limits', () => {
      const { props } = renderPanel()
      fireEvent.keyDown(separator(), { key: 'ArrowRight' })
      fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
      fireEvent.keyDown(separator(), { key: 'End' })
      fireEvent.keyDown(separator(), { key: 'Home' })
      expect(vi.mocked(props.onWidthChange).mock.calls).toEqual([[296], [264], [400], [240]])
    })

    it('follows a drag, stores the width once it ends, and keeps iframes off the pointer meanwhile', () => {
      const { props } = renderPanel()
      const handle = separator()
      handle.setPointerCapture = vi.fn()
      fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 })
      expect(document.body.hasAttribute('data-canopy-panel-resizing')).toBe(true)

      fireEvent.pointerMove(handle, { clientX: 350, pointerId: 1 })
      expect(screen.getByRole('region').style.width).toBe('330px')
      expect(props.onWidthChange).not.toHaveBeenCalled()

      fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientX: 900, pointerId: 1 })
      expect(props.onWidthChange).toHaveBeenCalledExactlyOnceWith(400)
      expect(document.body.hasAttribute('data-canopy-panel-resizing')).toBe(false)
    })

    it('abandons a drag when it closes mid-drag, so it reopens idle', () => {
      const { rerender, props } = renderPanel({ mode: 'overlay' })
      const handle = separator()
      handle.setPointerCapture = vi.fn()
      fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 })

      rerender(<SidePanelHost {...props} opened={false} />)
      expect(document.body.hasAttribute('data-canopy-panel-resizing')).toBe(false)

      rerender(<SidePanelHost {...props} opened />)
      expect(separator().hasAttribute('data-dragging')).toBe(false)
      expect(screen.getByRole('region').style.width).toBe('280px')
      fireEvent.pointerMove(separator(), { clientX: 400, pointerId: 1 })
      expect(screen.getByRole('region').style.width).toBe('280px')
      expect(props.onWidthChange).not.toHaveBeenCalled()
    })

    it('lets the iframes have the pointer back when it unmounts mid-drag', () => {
      const { unmount } = renderPanel()
      const handle = separator()
      handle.setPointerCapture = vi.fn()
      fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 })
      unmount()
      expect(document.body.hasAttribute('data-canopy-panel-resizing')).toBe(false)
    })
  })
})

function PortalledInput() {
  const [host] = useState(() => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    return element
  })
  return (
    <>
      {/* React bubbles a portal's events to its React parent, as Mantine's dialogs do. */}
      {createPortal(<input aria-label="In a dialog" />, host)}
    </>
  )
}
