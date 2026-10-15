'use client'

import React, { useEffect, useRef } from 'react'
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
const PANE_MIN_PX = 120

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
}: PaneLayoutProps) {
  const groupRef = useGroupRef()
  const separatorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const percent = arrangement === 'side' ? sideSplitPercent : stackedSplitPercent

  // Stored sizes load after mount, and the group must never remount: that would reload the preview.
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (Math.abs((group.getLayout()[PREVIEW] ?? percent) - percent) > 0.1) {
      group.setLayout(splitLayout(percent))
    }
  }, [groupRef, percent, arrangement])

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
    })
    observer.observe(separator, { attributes: true, attributeFilter: ['data-separator'] })
    return () => observer.disconnect()
  }, [])

  const side = arrangement === 'side'
  return (
    <Group
      groupRef={groupRef}
      orientation={side ? 'horizontal' : 'vertical'}
      defaultLayout={splitLayout(percent)}
      onLayoutChanged={(layout, meta) => {
        const next = layout[PREVIEW]
        if (meta.isUserInteraction && next !== undefined) onSplitPercentChange?.(arrangement, next)
      }}
      style={{ height: '100%', width: '100%' }}
    >
      <Panel id={PREVIEW} minSize={PANE_MIN_PX}>
        <Box
          ref={previewRef}
          data-testid="preview-pane"
          h="100%"
          w="100%"
          style={{ overflow: 'auto' }}
        >
          {preview}
        </Box>
      </Panel>
      <Separator
        elementRef={separatorRef}
        aria-label="Resize preview and form"
        style={{
          flexBasis: 8,
          background: 'var(--canopy-surface-muted)',
          boxShadow: 'inset 0 0 0 1px var(--mantine-color-default-border)',
        }}
      />
      <Panel id={FORM} minSize={PANE_MIN_PX}>
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
          }}
        >
          {form}
        </Box>
      </Panel>
    </Group>
  )
}
