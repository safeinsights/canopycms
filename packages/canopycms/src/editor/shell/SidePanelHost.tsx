'use client'

import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { CloseButton, Group, Text, Tooltip } from '@mantine/core'
import { useWindowEvent } from '@mantine/hooks'
import { focusIfIdle } from '../utils/focus-return'

/** Docked beside the main region, or laid over the form pane only. */
type SidePanelMode = 'docked' | 'overlay'

const KEY_STEP_PX = 16
const RESIZING_ATTR = 'data-canopy-panel-resizing'

const PANEL_STYLES = `
body[${RESIZING_ATTR}] { cursor: col-resize; user-select: none; }
body[${RESIZING_ATTR}] iframe { pointer-events: none; }
.canopy-side-panel-separator {
  position: absolute;
  inset-block: 0;
  inset-inline-end: -3px;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
  z-index: 1;
}
.canopy-side-panel-separator:hover,
.canopy-side-panel-separator[data-dragging] {
  background: var(--canopy-focus-ring);
}
.canopy-side-panel-separator:focus-visible {
  outline: 2px solid var(--canopy-focus-ring);
  outline-offset: -2px;
}
`

export interface SidePanelHostProps {
  title: string
  mode: SidePanelMode
  opened: boolean
  /** The stored width; a drag shows its own until it ends. */
  width: number
  minWidth: number
  maxWidth: number
  /** Called when a drag ends and on each resize key. */
  onWidthChange: (width: number) => void
  onClose: () => void
  /**
   * Bumped by the caller each time the user asks for the panel, open or not: each new value moves
   * focus in. Opening alone never does, as a panel also opens when stored state loads.
   */
  focusRequest?: number
  /** Where focus goes when the panel closes with focus inside it. */
  returnFocusTo?: () => HTMLElement | null
  /** Controls beside the title, before the close button. */
  actions?: ReactNode
  children: ReactNode
  id?: string
  'data-testid'?: string
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * A titled side panel, resizable from its inline-end edge. Docked, it is a column of the shell;
 * as an overlay it covers the form pane only, so the preview stays in view, and Escape closes it.
 * A `focusRequest` moves focus to its `data-autofocus` element, else to the panel; closing with
 * focus inside returns focus to `returnFocusTo`.
 */
export function SidePanelHost({
  title,
  mode,
  opened,
  width,
  minWidth,
  maxWidth,
  onWidthChange,
  onClose,
  focusRequest = 0,
  returnFocusTo,
  actions,
  children,
  id,
  'data-testid': testId,
}: SidePanelHostProps) {
  const fallbackId = useId()
  const panelId = id ?? fallbackId
  const titleId = `${panelId}-title`
  const panelRef = useRef<HTMLElement>(null)
  const focusInside = useRef(false)
  const wasOpened = useRef(opened)
  const servedFocusRequest = useRef(focusRequest)
  const drag = useRef<{ startX: number; startWidth: number; width: number; sign: number } | null>(
    null,
  )
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  if (!opened && dragWidth !== null) setDragWidth(null)
  const shownWidth = clamp(dragWidth ?? width, minWidth, maxWidth)

  useEffect(() => {
    const panel = panelRef.current
    const asked = opened && focusRequest !== servedFocusRequest.current
    servedFocusRequest.current = focusRequest
    if (!asked || !panel) return
    const autofocus = () => panel.querySelector<HTMLElement>('[data-autofocus]')
    const field = autofocus()
    if (field) {
      field.focus({ preventScroll: true })
      return
    }
    // The field may render with content still loading: it takes focus when it arrives, unless
    // focus has moved off the panel by then.
    panel.focus({ preventScroll: true })
    const observer = new MutationObserver(() => {
      if (document.activeElement !== panel) return observer.disconnect()
      const arrived = autofocus()
      if (!arrived) return
      observer.disconnect()
      arrived.focus({ preventScroll: true })
    })
    observer.observe(panel, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [opened, focusRequest])

  useEffect(() => {
    if (!opened && wasOpened.current) {
      // Its separator is gone, and with it the pointer capture that would have ended a drag.
      drag.current = null
      document.body.removeAttribute(RESIZING_ATTR)
      if (focusInside.current) {
        focusInside.current = false
        focusIfIdle(returnFocusTo?.() ?? null)
      }
    }
    wasOpened.current = opened
  }, [opened, returnFocusTo])

  // On the window, not the panel: a dialog portalled from the panel would bubble its Escape here
  // through React, so only a key from inside the panel's own DOM closes it.
  useWindowEvent('keydown', (event) => {
    if (
      opened &&
      mode === 'overlay' &&
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      event.target instanceof Node &&
      panelRef.current?.contains(event.target)
    ) {
      event.preventDefault()
      onClose()
    }
  })

  // A drag cut short by unmounting must not leave the page's iframes deaf to the pointer.
  useEffect(() => () => document.body.removeAttribute(RESIZING_ATTR), [])

  if (!opened) return null

  const endDrag = () => {
    const state = drag.current
    if (!state) return
    drag.current = null
    document.body.removeAttribute(RESIZING_ATTR)
    setDragWidth(null)
    onWidthChange(state.width)
  }

  const separatorHandlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
      drag.current = {
        startX: event.clientX,
        startWidth: shownWidth,
        width: shownWidth,
        sign: rtl ? -1 : 1,
      }
      document.body.setAttribute(RESIZING_ATTR, '')
      setDragWidth(shownWidth)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const state = drag.current
      if (!state) return
      state.width = clamp(
        state.startWidth + state.sign * (event.clientX - state.startX),
        minWidth,
        maxWidth,
      )
      setDragWidth(state.width)
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
      const grow = rtl ? 'ArrowLeft' : 'ArrowRight'
      const shrink = rtl ? 'ArrowRight' : 'ArrowLeft'
      const next =
        event.key === grow
          ? shownWidth + KEY_STEP_PX
          : event.key === shrink
            ? shownWidth - KEY_STEP_PX
            : event.key === 'Home'
              ? minWidth
              : event.key === 'End'
                ? maxWidth
                : undefined
      if (next === undefined) return
      event.preventDefault()
      onWidthChange(clamp(next, minWidth, maxWidth))
    },
  }

  const overlay = mode === 'overlay'
  const style: CSSProperties = {
    position: overlay ? 'absolute' : 'relative',
    insetBlock: overlay ? 0 : undefined,
    insetInlineStart: overlay ? 0 : undefined,
    zIndex: overlay ? 2 : undefined,
    boxShadow: overlay ? 'var(--mantine-shadow-md)' : undefined,
    width: shownWidth,
    maxWidth: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--mantine-color-body)',
    borderInlineEnd: '1px solid var(--canopy-input-border)',
  }

  return (
    <section
      ref={panelRef}
      id={panelId}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid={testId}
      data-panel-mode={mode}
      style={style}
      onFocus={() => {
        focusInside.current = true
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusInside.current = false
      }}
    >
      <style>{PANEL_STYLES}</style>
      <Group
        justify="space-between"
        wrap="nowrap"
        gap="xs"
        px="md"
        py="xs"
        style={{ borderBlockEnd: '1px solid var(--canopy-input-border)' }}
      >
        <Text id={titleId} component="h2" fw={600} size="md" m={0}>
          {title}
        </Text>
        <Group gap="xs" wrap="nowrap">
          {actions}
          <Tooltip label={`Close ${title.toLowerCase()} panel`}>
            <CloseButton aria-label={`Close ${title.toLowerCase()} panel`} onClick={onClose} />
          </Tooltip>
        </Group>
      </Group>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title.toLowerCase()} panel`}
        aria-controls={panelId}
        aria-valuenow={Math.round(shownWidth)}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        // A focusable separator is a window splitter, a widget; jsx-a11y counts every one static.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="canopy-side-panel-separator"
        data-dragging={dragWidth !== null || undefined}
        {...separatorHandlers}
      />
    </section>
  )
}
