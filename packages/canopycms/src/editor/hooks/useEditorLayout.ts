import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalStorage } from '@mantine/hooks'
import {
  DEFAULT_SIDE_SPLIT_PERCENT,
  DEFAULT_STACKED_SPLIT_PERCENT,
  SPLIT_PERCENT_MAX,
  SPLIT_PERCENT_MIN,
  type PaneLayout,
} from '../EditorPanes'
import { isPlainRecord } from '../../validation/field-traversal'

/** @internal Consumed by the preview toolbar, which does not exist yet. */
export type PreviewWidth = 'fit' | 'desktop' | 'tablet' | 'mobile'

const PREVIEW_WIDTHS: readonly PreviewWidth[] = ['fit', 'desktop', 'tablet', 'mobile']
const PANE_LAYOUTS: readonly PaneLayout[] = ['side', 'stacked']

const CONTENT_PANEL_WIDTH_MIN = 240
const CONTENT_PANEL_WIDTH_MAX = 400

/** The persisted layout preferences: one JSON object under one storage key. */
interface EditorLayoutPrefs {
  layout: PaneLayout
  highlightEnabled: boolean
  sideSplitPercent: number
  stackedSplitPercent: number
  previewWidth: PreviewWidth
  contentPanelOpen: boolean
  contentPanelWidth: number
}

/**
 * @internal Exported for tests. Module-level so its identity is stable: Mantine memoises its
 * storage reader on the default value.
 */
export const DEFAULT_EDITOR_LAYOUT_PREFS: EditorLayoutPrefs = {
  layout: 'side',
  highlightEnabled: false,
  sideSplitPercent: DEFAULT_SIDE_SPLIT_PERCENT,
  stackedSplitPercent: DEFAULT_STACKED_SPLIT_PERCENT,
  previewWidth: 'fit',
  contentPanelOpen: false,
  contentPanelWidth: 280,
}

/** One key per deployment prefix, so two editors on one origin keep separate preferences. */
export const editorLayoutStorageKey = (basePath?: string): string =>
  `canopycms:editor-layout:${basePath || '/'}`

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const clampSplitPercent = (percent: number): number =>
  clamp(percent, SPLIT_PERCENT_MIN, SPLIT_PERCENT_MAX)

const clampContentPanelWidth = (width: number): number =>
  clamp(width, CONTENT_PANEL_WIDTH_MIN, CONTENT_PANEL_WIDTH_MAX)

const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.find((option) => option === value) ?? fallback

const boolOr = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const numberOr = (value: unknown, fallback: number, normalise: (n: number) => number): number =>
  typeof value === 'number' && Number.isFinite(value) ? normalise(value) : fallback

/**
 * @internal Exported for tests. Reads stored preferences, validating each field on its own: an invalid or missing field takes
 * its default and the valid ones are kept. Mantine does not guard `deserialize`, so this never
 * throws, whatever is under the key.
 */
export function parseEditorLayoutPrefs(raw: string | undefined): EditorLayoutPrefs {
  const defaults = DEFAULT_EDITOR_LAYOUT_PREFS
  if (!raw) return defaults

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }
  if (!isPlainRecord(parsed)) return defaults

  return {
    layout: oneOf(PANE_LAYOUTS, parsed.layout, defaults.layout),
    highlightEnabled: boolOr(parsed.highlightEnabled, defaults.highlightEnabled),
    sideSplitPercent: numberOr(
      parsed.sideSplitPercent,
      defaults.sideSplitPercent,
      clampSplitPercent,
    ),
    stackedSplitPercent: numberOr(
      parsed.stackedSplitPercent,
      defaults.stackedSplitPercent,
      clampSplitPercent,
    ),
    previewWidth: oneOf(PREVIEW_WIDTHS, parsed.previewWidth, defaults.previewWidth),
    contentPanelOpen: boolOr(parsed.contentPanelOpen, defaults.contentPanelOpen),
    contentPanelWidth: numberOr(
      parsed.contentPanelWidth,
      defaults.contentPanelWidth,
      clampContentPanelWidth,
    ),
  }
}

export interface UseEditorLayoutOptions {
  /** Where the preferences persist; defaults to `editorLayoutStorageKey()`. */
  storageKey?: string
}

export interface UseEditorLayoutReturn {
  layout: PaneLayout
  setLayout: (layout: PaneLayout) => void
  highlightEnabled: boolean
  setHighlightEnabled: (enabled: boolean) => void
  sideSplitPercent: number
  stackedSplitPercent: number
  /** Stores the clamped primary-pane size for one layout; a non-finite percent is ignored. */
  setSplitPercent: (layout: PaneLayout, percent: number) => void
  previewWidth: PreviewWidth
  setPreviewWidth: (width: PreviewWidth) => void
  contentPanelOpen: boolean
  setContentPanelOpen: (open: boolean) => void
  contentPanelWidth: number
  setContentPanelWidth: (width: number) => void
  headerRef: React.RefObject<HTMLDivElement>
  headerHeight: number
}

/**
 * Editor layout: preferences persisted to localStorage (read after mount, so SSR renders the
 * defaults; a throwing storage keeps them in memory) plus the measured, unpersisted header height.
 * `previewWidth` and `contentPanel*` persist ahead of the toolbar and panel that will use them.
 */
export function useEditorLayout(options?: UseEditorLayoutOptions): UseEditorLayoutReturn {
  const [prefs, setPrefs] = useLocalStorage<EditorLayoutPrefs>({
    key: options?.storageKey ?? editorLayoutStorageKey(),
    defaultValue: DEFAULT_EDITOR_LAYOUT_PREFS,
    deserialize: parseEditorLayoutPrefs,
    // Each tab keeps its own layout; a change elsewhere reaches only tabs opened later.
    sync: false,
  })
  const [headerHeight, setHeaderHeight] = useState<number>(80)
  const headerRef = useRef<HTMLDivElement | null>(null)

  const setLayout = useCallback(
    (layout: PaneLayout) => setPrefs((prev) => ({ ...prev, layout })),
    [setPrefs],
  )
  const setHighlightEnabled = useCallback(
    (highlightEnabled: boolean) => setPrefs((prev) => ({ ...prev, highlightEnabled })),
    [setPrefs],
  )
  const setSplitPercent = useCallback(
    (layout: PaneLayout, percent: number) => {
      if (!Number.isFinite(percent)) return
      const clamped = clampSplitPercent(percent)
      setPrefs((prev) =>
        layout === 'side'
          ? { ...prev, sideSplitPercent: clamped }
          : { ...prev, stackedSplitPercent: clamped },
      )
    },
    [setPrefs],
  )
  const setPreviewWidth = useCallback(
    (previewWidth: PreviewWidth) => setPrefs((prev) => ({ ...prev, previewWidth })),
    [setPrefs],
  )
  const setContentPanelOpen = useCallback(
    (contentPanelOpen: boolean) => setPrefs((prev) => ({ ...prev, contentPanelOpen })),
    [setPrefs],
  )
  const setContentPanelWidth = useCallback(
    (width: number) => {
      if (!Number.isFinite(width)) return
      const contentPanelWidth = clampContentPanelWidth(width)
      setPrefs((prev) => ({ ...prev, contentPanelWidth }))
    },
    [setPrefs],
  )

  useEffect(() => {
    if (!headerRef.current) return

    const node = headerRef.current
    const updateHeight = () => setHeaderHeight(node.getBoundingClientRect().height || 80)

    updateHeight()

    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  return {
    layout: prefs.layout,
    setLayout,
    highlightEnabled: prefs.highlightEnabled,
    setHighlightEnabled,
    sideSplitPercent: prefs.sideSplitPercent,
    stackedSplitPercent: prefs.stackedSplitPercent,
    setSplitPercent,
    previewWidth: prefs.previewWidth,
    setPreviewWidth,
    contentPanelOpen: prefs.contentPanelOpen,
    setContentPanelOpen,
    contentPanelWidth: prefs.contentPanelWidth,
    setContentPanelWidth,
    headerRef,
    headerHeight,
  }
}
