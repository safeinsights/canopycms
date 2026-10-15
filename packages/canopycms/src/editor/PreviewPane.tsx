'use client'

import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import {
  ActionIcon,
  Box,
  Group,
  Select,
  Text,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core'
import { useClipboard, useElementSize } from '@mantine/hooks'
import { IconCheck, IconExternalLink, IconRefresh } from '@tabler/icons-react'

import type { PreviewWidth } from './hooks/useEditorLayout'
import { PreviewFrame, type PreviewMarks } from './PreviewFrame'
import { displayPreviewPath, type PreviewMount } from './preview-path'
import {
  computePreviewViewport,
  formatPreviewWidthReadout,
  PREVIEW_DEVICE_WIDTHS,
} from './preview-scale'

const WIDTH_OPTIONS: { value: PreviewWidth; label: string; detail: string }[] = [
  { value: 'fit', label: 'Fit', detail: 'Pane width' },
  { value: 'desktop', label: 'Desktop', detail: `${PREVIEW_DEVICE_WIDTHS.desktop} px` },
  { value: 'tablet', label: 'Tablet', detail: `${PREVIEW_DEVICE_WIDTHS.tablet} px` },
  { value: 'mobile', label: 'Mobile', detail: `${PREVIEW_DEVICE_WIDTHS.mobile} px` },
]

const isPreviewWidth = (value: string | null): value is PreviewWidth =>
  WIDTH_OPTIONS.some((option) => option.value === value)

const RELOAD_LABEL = 'Reload preview'
const OPEN_SAVED_LABEL = 'Open saved version in a new tab'

export interface PreviewPaneProps {
  src: string
  /** The page's path for the bridge and the toolbar; defaults to `src`. */
  path?: string
  /** Where the preview routes are mounted, which the toolbar's path leaves out. */
  mount?: PreviewMount
  data?: unknown
  isLoading?: unknown
  highlightEnabled?: boolean
  assetBase?: string
  onPreviewError?: (error: { message: string; fieldPath?: string } | null) => void
  onMarks?: (marks: PreviewMarks) => void
  previewWidth: PreviewWidth
  onPreviewWidthChange: (width: PreviewWidth) => void
  /** Shown between the toolbar and the preview, such as a preview error. */
  notice?: ReactNode
}

/**
 * The preview region: a toolbar (path, width, reload, saved version) over a `PreviewFrame`. A
 * fixed width renders the iframe at that CSS width, so the site's own breakpoints apply, scaled
 * down to fit a narrower pane.
 */
export const PreviewPane = ({
  src,
  path = src,
  mount,
  previewWidth,
  onPreviewWidthChange,
  notice,
  ...frameProps
}: PreviewPaneProps) => {
  const { ref: viewportRef, width, height } = useElementSize()
  const clipboard = useClipboard({ timeout: 2000 })
  const reloadButtonRef = useRef<HTMLButtonElement>(null)
  // A dismissed notice takes its focused Close button with it; the toolbar takes the focus back.
  // Focus anywhere else, such as a form field while a draft starts compiling, stays put.
  const hadNotice = useRef(false)
  useEffect(() => {
    if (hadNotice.current && !notice && document.activeElement === document.body) {
      reloadButtonRef.current?.focus()
    }
    hadNotice.current = Boolean(notice)
  }, [notice])
  // Reloading remounts the frame for a fresh handshake. It drops a reported error too: the
  // reloaded page reports it again if the draft still fails.
  const [reloads, setReloads] = useState(0)
  const reload = () => {
    setReloads((count) => count + 1)
    frameProps.onPreviewError?.(null)
  }

  const shownPath = displayPreviewPath(path, mount)
  const viewport = computePreviewViewport(previewWidth, width, height)
  const iframeStyle: CSSProperties | undefined =
    previewWidth === 'fit'
      ? undefined
      : {
          inset: 'auto',
          top: 0,
          left: viewport.offsetX,
          width: viewport.frameWidth,
          height: viewport.frameHeight,
          transform: `scale(${viewport.scale})`,
          transformOrigin: '0 0',
          background: 'var(--mantine-color-body)',
          boxShadow: '0 0 0 1px var(--mantine-color-default-border)',
        }
  const copyStatus = clipboard.copied
    ? 'Path copied'
    : clipboard.error
      ? "Couldn't copy the path"
      : ''
  const copyLabel = `Copy path ${shownPath}`

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        border: '1px solid var(--mantine-color-default-border)',
      }}
    >
      <Group
        role="group"
        aria-label="Preview toolbar"
        data-testid="preview-toolbar"
        gap={6}
        px={6}
        style={{
          // Wraps to a second row, rather than clipping, in a pane too narrow for one.
          minHeight: 32,
          rowGap: 0,
          flex: '0 0 auto',
          borderBottom: '1px solid var(--mantine-color-default-border)',
          background: 'var(--mantine-color-body)',
        }}
      >
        <Tooltip
          label={copyStatus || copyLabel}
          multiline
          maw={360}
          style={{ overflowWrap: 'anywhere' }}
        >
          <UnstyledButton
            onClick={() => clipboard.copy(shownPath)}
            aria-label={copyLabel}
            style={{ flex: '1 1 80px', minWidth: 0, borderRadius: 4, padding: '2px 4px' }}
          >
            <Text component="span" size="xs" ff="monospace" truncate="end" display="block">
              {shownPath}
            </Text>
          </UnstyledButton>
        </Tooltip>
        <VisuallyHidden role="status">{copyStatus}</VisuallyHidden>
        <Select
          aria-label="Preview width"
          data={WIDTH_OPTIONS}
          value={previewWidth}
          onChange={(value) => {
            if (isPreviewWidth(value)) onPreviewWidthChange(value)
          }}
          allowDeselect={false}
          size="xs"
          w={96}
          style={{ flexShrink: 0 }}
          styles={{ input: { height: 24, minHeight: 24 } }}
          comboboxProps={{ width: 170, position: 'bottom-end' }}
          renderOption={({ option, checked }) => (
            <Group gap={6} wrap="nowrap" w="100%">
              <IconCheck
                aria-hidden
                size={14}
                style={{ visibility: checked ? 'visible' : 'hidden' }}
              />
              <span style={{ flex: 1 }}>{option.label}</span>
              {/* Inherits the option's colour, which stays legible on the highlighted fill. */}
              <Text component="span" size="xs">
                {WIDTH_OPTIONS.find((o) => o.value === option.value)?.detail}
              </Text>
            </Group>
          )}
        />
        {width > 0 && (
          <Text
            size="xs"
            c="dimmed"
            data-testid="preview-width-readout"
            style={{ flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
          >
            {formatPreviewWidthReadout(viewport)}
          </Text>
        )}
        {/* One unit, so a wrapping toolbar never parts the two. */}
        <Group gap={6} wrap="nowrap">
          <Tooltip label={RELOAD_LABEL}>
            <ActionIcon
              ref={reloadButtonRef}
              variant="subtle"
              size="md"
              aria-label={RELOAD_LABEL}
              onClick={reload}
            >
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={OPEN_SAVED_LABEL}>
            <ActionIcon
              component="a"
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              variant="subtle"
              size="md"
              aria-label={OPEN_SAVED_LABEL}
            >
              <IconExternalLink size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {notice}
      <Box ref={viewportRef} pos="relative" style={{ flex: '1 1 auto', minHeight: 0 }}>
        <PreviewFrame
          key={reloads}
          src={src}
          path={path}
          {...frameProps}
          onReload={() => {
            // Retry goes with the frame it sits in; the toolbar's reload offers the same action.
            reload()
            reloadButtonRef.current?.focus()
          }}
          iframeStyle={iframeStyle}
          style={{
            position: 'absolute',
            inset: 0,
            background: previewWidth === 'fit' ? undefined : 'var(--canopy-surface-muted)',
          }}
        />
      </Box>
    </Box>
  )
}
