import { useEffect, useRef, useState } from 'react'
import type { PaneLayout } from '../EditorPanes'

export interface UseEditorLayoutReturn {
  layout: PaneLayout
  setLayout: (layout: PaneLayout) => void
  highlightEnabled: boolean
  setHighlightEnabled: (enabled: boolean) => void
  headerRef: React.RefObject<HTMLDivElement>
  headerHeight: number
}

/**
 * Custom hook for managing Editor layout state and measurements.
 *
 * Manages:
 * - Pane layout (side-by-side or stacked)
 * - Preview highlight toggle
 * - Header height measurement via ResizeObserver
 *
 * @example
 * ```tsx
 * const { layout, setLayout, highlightEnabled, setHighlightEnabled, headerRef, headerHeight } = useEditorLayout()
 *
 * // Toggle layout
 * setLayout(layout === 'side' ? 'stacked' : 'side')
 *
 * // Toggle highlights
 * setHighlightEnabled(!highlightEnabled)
 *
 * // Use header ref and height
 * <Paper ref={headerRef}>...</Paper>
 * <Box style={{ paddingTop: headerHeight }}>...</Box>
 * ```
 */
export function useEditorLayout(): UseEditorLayoutReturn {
  const [layout, setLayout] = useState<PaneLayout>('side')
  const [highlightEnabled, setHighlightEnabled] = useState(false)
  const [headerHeight, setHeaderHeight] = useState<number>(80)
  const headerRef = useRef<HTMLDivElement | null>(null)

  // Measure header height using ResizeObserver
  useEffect(() => {
    if (!headerRef.current) return

    const node = headerRef.current
    const updateHeight = () => setHeaderHeight(node.getBoundingClientRect().height || 80)

    // Initial measurement
    updateHeight()

    // Watch for size changes
    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  return {
    layout,
    setLayout,
    highlightEnabled,
    setHighlightEnabled,
    headerRef,
    headerHeight,
  }
}
