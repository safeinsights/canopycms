'use client'

import React, { useRef, type CSSProperties, type ReactNode } from 'react'
import { Portal, getDefaultZIndex } from '@mantine/core'
import { RemoveScroll } from 'react-remove-scroll'
import { useHideHostChrome } from './host-chrome'

export interface EditorShellProps {
  topBar: ReactNode
  banner?: ReactNode
  rail?: ReactNode
  panel?: ReactNode
  main: ReactNode
  /** Drawers, modals and palettes, each portalling itself into `<body>`. */
  overlays?: ReactNode
}

const gridStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Widgets a host adds outside its React tree bring their own z-index, so the shell takes the
  // highest layer under Mantine's drawers and modals.
  zIndex: getDefaultZIndex('modal') - 1,
  display: 'grid',
  gridTemplateAreas: '"topbar topbar topbar" "banner banner banner" "panel main rail"',
  gridTemplateRows: 'auto auto minmax(0, 1fr)',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  background: 'var(--canopy-surface-subtle)',
  color: 'var(--mantine-color-text)',
}

const region = (area: string): CSSProperties => ({ gridArea: area, minWidth: 0, minHeight: 0 })

/**
 * The editor's window: a full-viewport grid of regions (top bar, banner, rail, panel, main,
 * overlays), portalled into `<body>` above the host page, whose chrome it hides, makes inert and stops scrolling.
 * Layout only: features plug into the regions. The rail sits at the inline end, opposite the
 * toasts (`theme.tsx`).
 */
export function EditorShell({ topBar, banner, rail, panel, main, overlays }: EditorShellProps) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  useHideHostChrome(anchorRef)

  return (
    <>
      <span ref={anchorRef} hidden data-canopy-shell-anchor />
      <Portal>
        {/* No isolation: it would cancel scrolling in overlays outside this React tree, such as
            Clerk's account modal. The scroll bar lock alone stops the host page scrolling. */}
        <RemoveScroll noIsolation removeScrollBar style={gridStyle} data-canopy-shell="">
          <header style={region('topbar')} data-canopy-region="topbar">
            {topBar}
          </header>
          <div style={region('banner')} data-canopy-region="banner">
            {banner}
          </div>
          <div style={region('panel')} data-canopy-region="panel">
            {panel}
          </div>
          <main style={region('main')} data-canopy-region="main">
            {main}
          </main>
          <div style={region('rail')} data-canopy-region="rail">
            {rail}
          </div>
          {/* Absolute, so nothing an overlay leaves in place takes a grid cell. */}
          <div style={{ position: 'absolute' }} data-canopy-region="overlays">
            {overlays}
          </div>
        </RemoveScroll>
      </Portal>
    </>
  )
}
