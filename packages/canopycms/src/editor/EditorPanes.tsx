'use client'

import React, { useMemo, useRef, useState, useEffect } from 'react'

import { Box, Paper, rem } from '@mantine/core'
import SplitPane, { type SplitPaneProps } from 'react-split-pane'

export type PaneLayout = 'side' | 'stacked'

export interface EditorPanesProps {
  layout?: PaneLayout
  onLayoutChange?: (layout: PaneLayout) => void
  preview?: React.ReactNode
  form?: React.ReactNode
}

export const EditorPanes: React.FC<EditorPanesProps> = ({
  layout: layoutProp = 'side',
  onLayoutChange,
  preview,
  form,
}) => {
  const TypedSplitPane = SplitPane as unknown as React.ComponentType<
    React.PropsWithChildren<SplitPaneProps>
  >
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<PaneLayout>(layoutProp)
  const [sidePrimarySize, setSidePrimarySize] = useState<number>(52)
  const [stackedPrimarySize, setStackedPrimarySize] = useState<number>(58)
  // Turn off iframe/pane pointer events while dragging so the gutter keeps receiving mouse events.
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    setLayout(layoutProp)
  }, [layoutProp])

  const handleLayoutChange = (next: PaneLayout) => {
    setLayout(next)
    onLayoutChange?.(next)
  }

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

  const updateSizeFromPixels = (nextPixels: number, nextLayout: PaneLayout) => {
    const total =
      nextLayout === 'side'
        ? (splitContainerRef.current?.clientWidth ?? 0)
        : (splitContainerRef.current?.clientHeight ?? 0)
    // Guard: ensure valid dimensions before calculating
    if (!total || total <= 0 || nextPixels <= 0) return
    const percent = Math.min(85, Math.max(15, (nextPixels / total) * 100))
    if (nextLayout === 'side') {
      setSidePrimarySize(percent)
    } else {
      setStackedPrimarySize(percent)
    }
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
            onChange={(next) => updateSizeFromPixels(next, layout)}
            onDragStarted={() => setIsDragging(true)}
            onDragFinished={(next) => {
              updateSizeFromPixels(next, layout)
              setIsDragging(false)
            }}
            style={{
              position: 'relative',
              minHeight: 0,
              width: '100%',
              height: '100%',
              userSelect: isDragging ? 'none' : undefined,
            }}
            paneStyle={{ minWidth: 0, minHeight: 0, display: 'flex', overflow: 'auto' }}
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
