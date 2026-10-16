'use client'

import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Box } from '@mantine/core'
import { Group, Panel, Separator, useGroupRef, type Layout } from 'react-resizable-panels'
import { DIVIDER_COLOR, DIVIDER_TARGET_PX, DIVIDER_WIDTH_PX } from './EditorShell'

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

// The pointer target is the group's `resizeTargetMinimumSize`, wider than the bar it draws.
const SEPARATOR_STYLES = `
.canopy-pane-separator {
  min-width: ${DIVIDER_WIDTH_PX}px;
  min-height: ${DIVIDER_WIDTH_PX}px;
  background: ${DIVIDER_COLOR};
}
.canopy-pane-separator:is([data-separator='hover'], [data-separator='active']) {
  background: var(--canopy-focus-ring);
}
.canopy-pane-separator:focus-visible {
  outline: 2px solid var(--canopy-focus-ring);
}
`

export interface PaneLayoutProps {
  arrangement: PaneArrangement
  /** The preview's share (percent) beside the form; follows this prop when it changes. */
  sideSplitPercent?: number
  /** The preview's share (percent) above the form; follows this prop when it changes. */
  stackedSplitPercent?: number
  /** Called when a drag or a keyboard resize changes the split, with the preview's percent. */
  onSplitPercentChange?: (arrangement: PaneArrangement, percent: number) => void
  preview?: React.ReactNode
  form?: React.ReactNode
  /** Laid over the form pane, outside its scrolling: the side panel in overlay mode. */
  formOverlay?: React.ReactNode
  /**
   * Docked at the form pane's inline start, pushing the form aside: the side panel docked in the
   * stacked arrangement, where the preview above keeps its full width.
   */
  formAside?: React.ReactNode
  /** Takes the form out of focus and the pointer's reach while an open `formOverlay` hides it. */
  formInert?: boolean
  /** Lays the preview over the whole layout, form and separator inert, without remounting it. */
  previewMaximized?: boolean
  /** Called as a held separator first moves the split, and as it is let go after that. */
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
  formAside,
  formInert = false,
  previewMaximized = false,
  onSeparatorDrag,
}: PaneLayoutProps) {
  const groupRef = useGroupRef()
  const separatorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const formPanelRef = useRef<HTMLDivElement>(null)
  const [aside, setAside] = useState<HTMLDivElement | null>(null)
  const [asideWidth, setAsideWidth] = useState(0)
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

  // Where a maximized preview starts, beside a lifted `formAside`.
  useLayoutEffect(() => {
    if (!aside) return
    const measure = () => setAsideWidth(aside.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(aside)
    return () => observer.disconnect()
  }, [aside])

  const onSeparatorDragRef = useRef(onSeparatorDrag)
  useEffect(() => {
    onSeparatorDragRef.current = onSeparatorDrag
  }, [onSeparatorDrag])
  // A press alone is no drag: one that only focuses the separator must not report one.
  const hold = useRef<{ start: number; moved: boolean } | null>(null)

  // An iframe takes the pointer moves a drag needs, so the panes ignore the pointer while the
  // separator is held. Set on the DOM as the attribute flips, before the first move arrives.
  useEffect(() => {
    const separator = separatorRef.current
    if (!separator) return
    const observer = new MutationObserver(() => {
      const held = separator.getAttribute('data-separator') === 'active'
      for (const pane of [previewRef.current, formRef.current]) {
        if (pane) pane.style.pointerEvents = held ? 'none' : ''
      }
      if (held && !hold.current) {
        hold.current = { start: groupRef.current?.getLayout()[PREVIEW] ?? 0, moved: false }
      } else if (!held && hold.current) {
        if (hold.current.moved) onSeparatorDragRef.current?.(false)
        hold.current = null
      }
    })
    observer.observe(separator, { attributes: true, attributeFilter: ['data-separator'] })
    return () => observer.disconnect()
  }, [groupRef])

  const side = arrangement === 'side'
  // A maximized preview leaves a docked `formAside` beside it, now the layout's full height, as
  // the shell's own panel column stays beside it in the side arrangement.
  const maximizedStyle: CSSProperties = formAside
    ? { insetBlock: 0, insetInlineEnd: 0, insetInlineStart: asideWidth }
    : { inset: 0 }
  return (
    <>
      <style>{SEPARATOR_STYLES}</style>
      <Group
        groupRef={groupRef}
        orientation={side ? 'horizontal' : 'vertical'}
        resizeTargetMinimumSize={DIVIDER_TARGET_PX}
        defaultLayout={splitLayout(percent)}
        // The hidden separator would otherwise still take drags over a maximized preview: the
        // library hit-tests separators by their rectangles, which `inert` leaves in place.
        disabled={previewMaximized}
        onLayoutChange={(layout) => {
          const next = layout[PREVIEW]
          const held = hold.current
          if (held && !held.moved && next !== undefined && Math.abs(next - held.start) > 0.01) {
            held.moved = true
            onSeparatorDragRef.current?.(true)
          }
        }}
        onLayoutChanged={(layout, meta) => {
          const next = layout[PREVIEW]
          if (meta.isUserInteraction && next !== undefined && Math.abs(next - percent) > 0.01)
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
            // Sized in `style`, not by props: Mantine's style props would override the insets.
            style={
              previewMaximized
                ? { overflow: 'auto', position: 'absolute', zIndex: 1, ...maximizedStyle }
                : { overflow: 'auto', width: '100%', height: '100%' }
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
          {/* Unpositioned, as the panels are, so a lifted `formAside` places itself in the group. */}
          <Box h="100%" w="100%" display="flex">
            {formAside && (
              <Box
                ref={setAside}
                data-testid="form-aside"
                data-lifted={previewMaximized || undefined}
                style={
                  previewMaximized
                    ? { position: 'absolute', insetBlock: 0, insetInlineStart: 0, zIndex: 1 }
                    : { flex: 'none', height: '100%' }
                }
              >
                {formAside}
              </Box>
            )}
            <Box
              ref={formPanelRef}
              pos="relative"
              h="100%"
              miw={0}
              // `formOverlay` stacks within this pane, so a maximized preview always covers it.
              style={{ flex: 1, isolation: 'isolate' }}
            >
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
          </Box>
        </Panel>
      </Group>
    </>
  )
}
