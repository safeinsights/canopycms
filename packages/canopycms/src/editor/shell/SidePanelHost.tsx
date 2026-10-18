'use client'

import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { CloseButton, Group, Text, Tooltip, Transition } from '@mantine/core'
import { useReducedMotion, useWindowEvent } from '@mantine/hooks'
import { FOCUS_RETURN_ATTR, focusIfIdle } from '../utils/focus-return'
import { DIVIDER_COLOR, DIVIDER_TARGET_PX, DIVIDER_WIDTH_PX } from './EditorShell'

/** Docked, pushing its neighbours aside, or laid over the form pane only. */
type SidePanelMode = 'docked' | 'overlay'

const KEY_STEP_PX = 16
const RESIZING_ATTR = 'data-canopy-panel-resizing'
/** The drawers' slide: Mantine's `Transition` default. */
const SLIDE_MS = 250

const targetOverhang = (target: number) => (target - DIVIDER_WIDTH_PX) / 2

// The separator is the panel's last pixels; its `::before` is the wider pointer target.
const PANEL_STYLES = `
body[${RESIZING_ATTR}] { cursor: col-resize; user-select: none; }
body[${RESIZING_ATTR}] iframe { pointer-events: none; }
.canopy-side-panel-separator {
  position: absolute;
  inset-block: 0;
  inset-inline-end: 0;
  width: ${DIVIDER_WIDTH_PX}px;
  background: ${DIVIDER_COLOR};
  cursor: col-resize;
  touch-action: none;
  z-index: 1;
}
.canopy-side-panel-separator::before {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline: -${targetOverhang(DIVIDER_TARGET_PX.fine)}px;
}
@media (pointer: coarse) {
  .canopy-side-panel-separator::before {
    inset-inline: -${targetOverhang(DIVIDER_TARGET_PX.coarse)}px;
  }
}
.canopy-side-panel-separator:hover,
.canopy-side-panel-separator:focus-visible,
.canopy-side-panel-separator[data-dragging] {
  background: var(--canopy-focus-ring);
}
.canopy-side-panel-separator:focus-visible {
  outline: 2px solid var(--canopy-focus-ring);
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
  /** Focus moved to `target`, outside the panel and what it portals; to nothing isn't leaving. */
  onFocusLeave?: (target: Element) => void
  /** Controls beside the title, before the close button. */
  actions?: ReactNode
  children: ReactNode
  id?: string
  'data-testid'?: string
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * A titled side panel, resizable from its inline-end edge. Docked, it pushes its neighbours aside
 * and opens and closes at once: a sliding width would reflow the preview's page on every frame.
 * As an overlay it covers the form pane only, so the preview stays in view, slides in and out as
 * the drawers do unless the user prefers reduced motion, and Escape closes it. A `focusRequest`
 * moves focus to its `data-autofocus` element, else to the panel; closing with focus inside
 * returns focus to `returnFocusTo`.
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
  onFocusLeave,
  actions,
  children,
  id,
  'data-testid': testId,
}: SidePanelHostProps) {
  const fallbackId = useId()
  const panelId = id ?? fallbackId
  const titleId = `${panelId}-title`
  // State, not a ref: an overlay's section mounts a frame after `opened`, as its slide starts.
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  const focusInside = useRef(false)
  const focusLeaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(focusLeaveTimer.current), [])
  const closingWithFocus = useRef(false)
  const wasOpened = useRef(opened)
  const servedFocusRequest = useRef(focusRequest)
  const reduceMotion = useReducedMotion()
  // The slide's direction, read from the page as each opening starts, as the resize keys read it.
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [rtl, setRtl] = useState(false)
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (opened && anchor) setRtl(getComputedStyle(anchor).direction === 'rtl')
  }, [opened])
  const drag = useRef<{ startX: number; startWidth: number; width: number; sign: number } | null>(
    null,
  )
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  if (!opened && dragWidth !== null) setDragWidth(null)
  const shownWidth = clamp(dragWidth ?? width, minWidth, maxWidth)

  useEffect(() => {
    // A request made while closed lapses; one made as it opens waits for the section to mount.
    if (!opened) servedFocusRequest.current = focusRequest
    if (!opened || !panel || focusRequest === servedFocusRequest.current) return
    servedFocusRequest.current = focusRequest
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
  }, [opened, focusRequest, panel])

  // A sliding-out overlay is inert, so it neither holds focus nor takes the pointer. Whether focus
  // was inside is read first, as `inert` can blur it.
  useLayoutEffect(() => {
    if (!opened && wasOpened.current) closingWithFocus.current = focusInside.current
    panel?.toggleAttribute('inert', !opened)
  }, [opened, panel])

  useEffect(() => {
    if (!opened && wasOpened.current) {
      // Its separator is gone or inert, and with it the pointer capture that would end a drag.
      drag.current = null
      document.body.removeAttribute(RESIZING_ATTR)
      if (closingWithFocus.current) {
        closingWithFocus.current = false
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
      panel?.contains(event.target)
    ) {
      event.preventDefault()
      onClose()
    }
  })

  // A drag cut short by unmounting must not leave the page's iframes deaf to the pointer.
  useEffect(() => () => document.body.removeAttribute(RESIZING_ATTR), [])

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
    paddingInlineEnd: DIVIDER_WIDTH_PX,
  }

  return (
    <>
      <span ref={anchorRef} hidden />
      <Transition
        mounted={opened}
        transition={rtl ? 'slide-left' : 'slide-right'}
        duration={overlay && !reduceMotion ? SLIDE_MS : 0}
      >
        {(transitionStyles) => (
          <section
            ref={setPanel}
            id={panelId}
            aria-labelledby={titleId}
            tabIndex={-1}
            data-testid={testId}
            data-panel-mode={mode}
            // While it slides out, focus left inside it counts as idle, so it can still go back.
            {...{ [FOCUS_RETURN_ATTR]: opened ? undefined : '' }}
            style={{ ...style, ...transitionStyles }}
            onFocus={() => {
              focusInside.current = true
              clearTimeout(focusLeaveTimer.current)
            }}
            onBlur={(event) => {
              const next = event.relatedTarget
              if (event.currentTarget.contains(next)) return
              focusInside.current = false
              if (!(next instanceof Element)) return
              // React bubbles focus through portals, so a portaled descendant taking focus runs
              // `onFocus` above, in the same task, and cancels this.
              clearTimeout(focusLeaveTimer.current)
              focusLeaveTimer.current = setTimeout(() => onFocusLeave?.(next), 0)
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
                  <CloseButton
                    aria-label={`Close ${title.toLowerCase()} panel`}
                    onClick={onClose}
                  />
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
        )}
      </Transition>
    </>
  )
}
