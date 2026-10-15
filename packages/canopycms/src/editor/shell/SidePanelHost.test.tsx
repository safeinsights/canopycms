import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SidePanelHost, type SidePanelHostProps } from './SidePanelHost'
import { CanopyCMSProvider } from '../theme'

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

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-canopy-panel-resizing')
})

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
function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [opened, setOpened] = useState(initiallyOpen)
  const toggle = useRef<HTMLButtonElement>(null)
  return (
    <CanopyCMSProvider>
      <button ref={toggle} onClick={() => setOpened((open) => !open)}>
        Toggle
      </button>
      <SidePanelHost
        {...baseProps()}
        opened={opened}
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
    it('takes focus when it opens, and returns it to the opener when it closes', () => {
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

    it('focuses its data-autofocus element when it opens', () => {
      const { rerender, props } = renderPanel({ opened: false })
      rerender(
        <SidePanelHost {...props} opened>
          <input aria-label="Filter" data-autofocus />
        </SidePanelHost>,
      )
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter' }))
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
