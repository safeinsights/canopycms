'use client'

import React, { useMemo, useRef, useState, useEffect } from 'react'

import { Box, Paper, rem } from '@mantine/core'
import SplitPane, { type SplitPaneProps } from 'react-split-pane'

export type PaneLayout = 'side' | 'stacked'

export const SPLIT_PERCENT_MIN = 15
export const SPLIT_PERCENT_MAX = 85
export const DEFAULT_SIDE_SPLIT_PERCENT = 52
export const DEFAULT_STACKED_SPLIT_PERCENT = 58

export interface EditorPanesProps {
  layout?: PaneLayout
  onLayoutChange?: (layout: PaneLayout) => void
  /** Primary-pane size (percent) in the side layout; follows this prop when it changes. */
  sideSplitPercent?: number
  /** Primary-pane size (percent) in the stacked layout; follows this prop when it changes. */
  stackedSplitPercent?: number
  /** Called once per drag, when it ends, with the clamped percent; live dragging never calls it. */
  onSplitPercentChange?: (layout: PaneLayout, percent: number) => void
  preview?: React.ReactNode
  form?: React.ReactNode
}

export const EditorPanes: React.FC<EditorPanesProps> = ({
  layout: layoutProp = 'side',
  onLayoutChange: _,
  sideSplitPercent = DEFAULT_SIDE_SPLIT_PERCENT,
  stackedSplitPercent = DEFAULT_STACKED_SPLIT_PERCENT,
  onSplitPercentChange,
  preview,
  form,
}) => {
  const TypedSplitPane = SplitPane as unknown as React.ComponentType<
    React.PropsWithChildren<SplitPaneProps>
  >
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<PaneLayout>(layoutProp)
  // Live drag state: the props only change when a drag ends, so dragging never writes storage.
  const [sidePrimarySize, setSidePrimarySize] = useState<number>(sideSplitPercent)
  const [stackedPrimarySize, setStackedPrimarySize] = useState<number>(stackedSplitPercent)
  // Turn off iframe/pane pointer events while dragging so the gutter keeps receiving mouse events.
  const [isDragging, setIsDragging] = useState(false)
  // The last percent a drag produced. `onDragFinished` cannot supply it: once `size` is
  // controlled, react-split-pane hands back that prop's string ("37%"), or undefined after a
  // click with no movement.
  const dragPercentRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    setLayout(layoutProp)
  }, [layoutProp])

  useEffect(() => {
    setSidePrimarySize(sideSplitPercent)
  }, [sideSplitPercent])

  useEffect(() => {
    setStackedPrimarySize(stackedSplitPercent)
  }, [stackedSplitPercent])

  const direction = layout === 'side' ? 'vertical' : 'horizontal'
  const primarySize = useMemo(
    () => (layout === 'side' ? sidePrimarySize : stackedPrimarySize),
    [layout, sidePrimarySize, stackedPrimarySize],
  )

  const resizerStyle = useMemo(
    () => ({
      background:
        layout === 'side'
          ? 'linear-gradient(90deg, var(--mantine-color-gray-0), var(--mantine-color-gray-1))'
          : 'linear-gradient(180deg, var(--mantine-color-gray-0), var(--mantine-color-gray-1))',
      boxShadow: isDragging
        ? 'inset 0 0 0 1px var(--mantine-color-brand-4), 0 0 0 1px var(--mantine-color-brand-1)'
        : 'inset 0 0 0 1px var(--mantine-color-gray-3)',
      cursor: layout === 'side' ? 'col-resize' : 'row-resize',
      width: layout === 'side' ? rem(12) : '100%',
      height: layout === 'side' ? '100%' : rem(12),
      margin: layout === 'side' ? `0 -${rem(2)}` : `-${rem(2)} 0`,
      borderRadius: layout === 'side' ? rem(0) : rem(0),
      transition: 'box-shadow 120ms ease, background 120ms ease',
      flexShrink: 0,
    }),
    [isDragging, layout],
  )

  const updateSizeFromPixels = (nextPixels: number, nextLayout: PaneLayout): number | undefined => {
    const total =
      nextLayout === 'side'
        ? (splitContainerRef.current?.clientWidth ?? 0)
        : (splitContainerRef.current?.clientHeight ?? 0)
    // Guard: ensure valid dimensions before calculating
    if (!total || total <= 0 || !Number.isFinite(nextPixels) || nextPixels <= 0) return undefined
    const percent = Math.min(
      SPLIT_PERCENT_MAX,
      Math.max(SPLIT_PERCENT_MIN, (nextPixels / total) * 100),
    )
    if (nextLayout === 'side') {
      setSidePrimarySize(percent)
    } else {
      setStackedPrimarySize(percent)
    }
    return percent
  }

  return (
    <Box h="100%" style={{ minHeight: '70vh' }}>
      <Paper
        radius={0}
        shadow="xs"
        withBorder
        style={{
          display: 'flex',
          height: '100%',
          minHeight: 0,
          overflow: 'hidden',
          flexDirection: layout === 'side' ? 'row' : 'column',
          width: '100%',
        }}
      >
        <Box
          ref={splitContainerRef}
          style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%' }}
        >
          <TypedSplitPane
            split={direction}
            minSize={120}
            size={`${primarySize}%`}
            allowResize
            onChange={(next) => {
              dragPercentRef.current = updateSizeFromPixels(next, layout) ?? dragPercentRef.current
            }}
            onDragStarted={() => {
              dragPercentRef.current = undefined
              setIsDragging(true)
            }}
            onDragFinished={() => {
              const percent = dragPercentRef.current
              dragPercentRef.current = undefined
              if (percent !== undefined) onSplitPercentChange?.(layout, percent)
              setIsDragging(false)
            }}
            style={{
              position: 'relative',
              minHeight: 0,
              width: '100%',
              height: '100%',
              userSelect: isDragging ? 'none' : undefined,
            }}
            paneStyle={{
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              overflow: 'auto',
            }}
            resizerStyle={resizerStyle}
          >
            <Box
              data-testid="preview-pane"
              style={{
                minWidth: 0,
                minHeight: 0,
                overflow: 'auto',
                flex: 1,
                pointerEvents: isDragging ? 'none' : undefined,
              }}
            >
              <Box
                h="100%"
                w="100%"
                style={{
                  minHeight: '100%',
                  minWidth: 0,
                  overflow: 'auto',
                  flex: 1,
                  pointerEvents: isDragging ? 'none' : undefined,
                }}
              >
                {preview ?? 'Preview'}
              </Box>
            </Box>
            <Box
              data-testid="form-pane"
              style={{
                minWidth: 0,
                minHeight: 0,
                overflow: 'auto',
                flex: 1,
                pointerEvents: isDragging ? 'none' : undefined,
              }}
            >
              <Box
                h="100%"
                w="100%"
                style={{
                  padding: 20,
                  minHeight: '100%',
                  minWidth: 0,
                  overflow: 'auto',
                  flex: 1,
                  pointerEvents: isDragging ? 'none' : undefined,
                  backgroundColor: 'var(--mantine-color-gray-1)',
                }}
              >
                {form ?? 'Form'}
              </Box>
            </Box>
          </TypedSplitPane>
        </Box>
      </Paper>
    </Box>
  )
}

export default EditorPanes
