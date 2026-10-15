'use client'

import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { Box } from '@mantine/core'
import { Group, Panel, Separator, useGroupRef, type Layout } from 'react-resizable-panels'

/** Preview beside the form, or above it. */
export type PaneArrangement = 'side' | 'stacked'

export const SPLIT_PERCENT_MIN = 15
export const SPLIT_PERCENT_MAX = 85
export const DEFAULT_SIDE_SPLIT_PERCENT = 52
export const DEFAULT_STACKED_SPLIT_PERCENT = 58

const PREVIEW = 'canopy-preview'
const FORM = 'canopy-form'
// The preview's limits are the stored split's, so a drag never ends somewhere storage would move;
// the form also keeps a usable minimum in a narrow window.
const PREVIEW_LIMITS = { minSize: `${SPLIT_PERCENT_MIN}%`, maxSize: `${SPLIT_PERCENT_MAX}%` }
const FORM_MIN_PX = 160

const SEPARATOR_STYLES = `
.canopy-pane-separator {
  min-width: 8px;
  min-height: 8px;
  background: var(--canopy-surface-muted);
  box-shadow: inset 0 0 0 1px var(--canopy-input-border);
}
.canopy-pane-separator:is([data-separator='hover'], [data-separator='active']) {
  background: var(--canopy-focus-ring);
}
.canopy-pane-separator:focus-visible {
  outline: 2px solid var(--canopy-focus-ring);
  outline-offset: -2px;
}
`

export interface PaneLayoutProps {
  arrangement: PaneArrangement
  /** The preview's share (percent) beside the form; follows this prop when it changes. */
  sideSplitPercent?: number
  /** The preview's share (percent) above the form; follows this prop when it changes. */
  stackedSplitPercent?: number
  /** Called when a drag or a keyboard resize ends, with the preview's percent. */
  onSplitPercentChange?: (arrangement: PaneArrangement, percent: number) => void
  preview?: React.ReactNode
  form?: React.ReactNode
  /** Laid over the form pane, outside its scrolling: the side panel in overlay mode. */
  formOverlay?: React.ReactNode
  /** Takes the form out of focus and the pointer's reach while an open `formOverlay` hides it. */
  formInert?: boolean
  /** Lays the preview over the whole layout, form and separator inert, without remounting it. */
  previewMaximized?: boolean
  /** Called as a pointer drag of the separator starts and ends. */
  onSeparatorDrag?: (dragging: boolean) => void
}

const splitLayout = (percent: number): Layout => ({ [PREVIEW]: percent, [FORM]: 100 - percent })

/** The resizable preview/form split that fills the shell's main region. */
export function PaneLayout({
  arrangement,
  sideSplitPercent = DEFAULT_SIDE_SPLIT_PERCENT,
  stackedSplitPercent = DEFAULT_STACKED_SPLIT_PERCENT,
  onSplitPercentChange,
  preview,
  form,
  formOverlay,
  formInert = false,
  previewMaximized = false,
  onSeparatorDrag,
}: PaneLayoutProps) {
  const groupRef = useGroupRef()
  const separatorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const formPanelRef = useRef<HTMLDivElement>(null)
  const percent = arrangement === 'side' ? sideSplitPercent : stackedSplitPercent

  // Stored sizes load after mount, and the group must never remount: that would reload the preview.
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (Math.abs((group.getLayout()[PREVIEW] ?? percent) - percent) > 0.1) {
      group.setLayout(splitLayout(percent))
    }
  }, [groupRef, percent, arrangement])

  // React 18 has no `inert` prop, so it is set on the DOM. A layout effect, so it changes before
  // any passive effect of the same commit tries to focus into the form or out of the overlay.
  useLayoutEffect(() => {
    formRef.current?.toggleAttribute('inert', formInert)
    formPanelRef.current?.toggleAttribute('inert', previewMaximized)
    separatorRef.current?.toggleAttribute('inert', previewMaximized)
  }, [formInert, previewMaximized])

  const onSeparatorDragRef = useRef(onSeparatorDrag)
  useEffect(() => {
    onSeparatorDragRef.current = onSeparatorDrag
  }, [onSeparatorDrag])

  // An iframe takes the pointer moves a drag needs, so the panes ignore the pointer while the
  // separator is held. Set on the DOM as the attribute flips, before the first move arrives.
  useEffect(() => {
    const separator = separatorRef.current
    if (!separator) return
    let wasHeld = false
    const observer = new MutationObserver(() => {
      const held = separator.getAttribute('data-separator') === 'active'
      for (const pane of [previewRef.current, formRef.current]) {
        if (pane) pane.style.pointerEvents = held ? 'none' : ''
      }
      if (held !== wasHeld) onSeparatorDragRef.current?.(held)
      wasHeld = held
    })
    observer.observe(separator, { attributes: true, attributeFilter: ['data-separator'] })
    return () => observer.disconnect()
  }, [])

  const side = arrangement === 'side'
  return (
    <>
      <style>{SEPARATOR_STYLES}</style>
      <Group
        groupRef={groupRef}
        orientation={side ? 'horizontal' : 'vertical'}
        defaultLayout={splitLayout(percent)}
        onLayoutChanged={(layout, meta) => {
          const next = layout[PREVIEW]
          if (meta.isUserInteraction && next !== undefined)
            onSplitPercentChange?.(arrangement, next)
        }}
        // The maximized preview's containing block: the panels themselves are unpositioned.
        style={{ height: '100%', width: '100%', position: 'relative' }}
      >
        <Panel id={PREVIEW} {...PREVIEW_LIMITS}>
          <Box
            ref={previewRef}
            data-testid="preview-pane"
            data-maximized={previewMaximized || undefined}
            h="100%"
            w="100%"
            style={
              previewMaximized
                ? { overflow: 'auto', position: 'absolute', inset: 0, zIndex: 1 }
                : { overflow: 'auto' }
            }
          >
            {preview}
          </Box>
        </Panel>
        <Separator
          elementRef={separatorRef}
          aria-label="Resize preview and form"
          className="canopy-pane-separator"
        />
        <Panel id={FORM} minSize={FORM_MIN_PX}>
          <Box ref={formPanelRef} pos="relative" h="100%" w="100%">
            <Box
              ref={formRef}
              data-testid="form-pane"
              h="100%"
              w="100%"
              style={{
                // FormHeader reads this to span the padding.
                '--canopy-form-pane-padding': '20px',
                padding: 'var(--canopy-form-pane-padding)',
                overflow: 'auto',
                backgroundColor: 'var(--canopy-surface-muted)',
                // Keeps the form's sticky header under `formOverlay`.
                isolation: 'isolate',
              }}
            >
              {form}
            </Box>
            {formOverlay}
          </Box>
        </Panel>
      </Group>
    </>
  )
}
