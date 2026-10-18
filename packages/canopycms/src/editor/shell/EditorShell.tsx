'use client'

import React, { useRef, type CSSProperties, type ReactNode } from 'react'
import { Portal, getDefaultZIndex } from '@mantine/core'
import { RemoveScroll } from 'react-remove-scroll'
import { useHideHostChrome } from './host-chrome'

export interface EditorShellProps {
  topBar?: ReactNode
  banner?: ReactNode
  rail?: ReactNode
  panel?: ReactNode
  main: ReactNode
  /** Drawers, modals and palettes, each portalling itself into `<body>`. */
  overlays?: ReactNode
}

/** The line between two shell regions, as under the top bar and a shown banner. */
export const SHELL_REGION_BORDER = '1px solid var(--canopy-input-border)'

/**
 * Every resizable divider in the shell, the panel's and the panes', shows this many pixels wide.
 * Its pointer target is wider, `DIVIDER_TARGET_PX`. A finger's reaches 6px past each side of the
 * bar: under the panes' separator, the narrow window's overlay panel keeps its header's close
 * button clear, as that header's top padding is 10px.
 */
export const DIVIDER_WIDTH_PX = 4
export const DIVIDER_TARGET_PX = { fine: 12, coarse: 16 } as const
/** A divider's colour at rest; held, hovered, dragged or focused it takes `--canopy-focus-ring`. */
export const DIVIDER_COLOR = 'var(--canopy-input-border)'

// A banner component may render nothing, so the region's line follows its content, not the prop.
const SHELL_STYLES = `
[data-canopy-region='banner']:not(:empty) { border-block-end: ${SHELL_REGION_BORDER}; }
`

const gridStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Widgets a host adds outside its React tree bring their own z-index, so the shell sits just
  // under Mantine's drawers and modals, leaving the layer between for MDXEditor's popups.
  zIndex: getDefaultZIndex('modal') - 2,
  display: 'grid',
  gridTemplateAreas: '"topbar topbar topbar" "banner banner banner" "rail panel main"',
  gridTemplateRows: 'auto auto minmax(0, 1fr)',
  gridTemplateColumns: 'auto auto minmax(0, 1fr)',
  background: 'var(--canopy-surface-subtle)',
  color: 'var(--mantine-color-text)',
}

const region = (area: string): CSSProperties => ({ gridArea: area, minWidth: 0, minHeight: 0 })

/**
 * The editor's window: a full-viewport grid of regions (top bar, banner, rail, panel, main,
 * overlays), portalled into `<body>` above the host page, whose chrome it hides and makes inert
 * and whose scrolling it stops. Layout only: features plug into the regions. The rail sits at the
 * inline start, opposite the toasts (`theme.tsx`), and comes first after the banner in focus order.
 */
export function EditorShell({ topBar, banner, rail, panel, main, overlays }: EditorShellProps) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  useHideHostChrome(anchorRef)

  return (
    <>
      <span ref={anchorRef} hidden data-canopy-shell-anchor />
      <Portal>
        {/* No isolation: it would cancel wheel and touch scrolling in any overlay outside this
            React tree. The scroll bar lock alone stops the host page scrolling. */}
        <RemoveScroll noIsolation removeScrollBar style={gridStyle} data-canopy-shell="">
          <style>{SHELL_STYLES}</style>
          {topBar && (
            <header style={region('topbar')} data-canopy-region="topbar">
              {topBar}
            </header>
          )}
          <div style={region('banner')} data-canopy-region="banner">
            {banner}
          </div>
          {rail && (
            <aside style={region('rail')} data-canopy-region="rail" aria-label="Editor tools">
              {rail}
            </aside>
          )}
          <div style={region('panel')} data-canopy-region="panel">
            {panel}
          </div>
          <main style={region('main')} data-canopy-region="main">
            {main}
          </main>
          {/* Absolute, so nothing an overlay leaves in place takes a grid cell. */}
          <div style={{ position: 'absolute' }} data-canopy-region="overlays">
            {overlays}
          </div>
        </RemoveScroll>
      </Portal>
    </>
  )
}
