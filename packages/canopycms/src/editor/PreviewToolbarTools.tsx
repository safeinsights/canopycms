'use client'

import type { Ref } from 'react'
import { useId, useRef, useState } from 'react'

import {
  ActionIcon,
  Button,
  Group,
  Popover,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core'
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconLayoutNavbar,
  IconMarquee,
} from '@tabler/icons-react'

import type { InexactMark } from './preview-marks'

const HIGHLIGHT_LABEL = 'Highlight fields in the preview'
const NOTHING_MARKED_NOTE =
  "This page marks no editable elements, so nothing can be highlighted or clicked to focus. The site's developer can mark them with fieldProps."

export interface HighlightToggleProps {
  enabled: boolean
  onToggle: () => void
  /** The page reported marking nothing while highlighting. */
  marksNothing?: boolean
}

/** Turns preview highlights on and off; says so when the page marks nothing to highlight. */
export function HighlightToggle({ enabled, onToggle, marksNothing = false }: HighlightToggleProps) {
  const noteId = useId()
  const showNote = enabled && marksNothing
  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={HIGHLIGHT_LABEL}>
        <ActionIcon
          variant={enabled ? 'filled' : 'subtle'}
          color={enabled ? 'brand' : 'gray'}
          size="md"
          aria-pressed={enabled}
          aria-label={HIGHLIGHT_LABEL}
          aria-describedby={showNote ? noteId : undefined}
          data-testid="toggle-highlights-button"
          onClick={onToggle}
        >
          <IconMarquee size={16} />
        </ActionIcon>
      </Tooltip>
      {showNote && (
        <Tooltip label={NOTHING_MARKED_NOTE} multiline w={260}>
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            Nothing to highlight
            <VisuallyHidden id={noteId}>{NOTHING_MARKED_NOTE}</VisuallyHidden>
          </Text>
        </Tooltip>
      )}
    </Group>
  )
}

const SITE_CHROME_LABEL = 'Show site header and footer'
const SITE_CHROME_FAILED_NOTE =
  "The site couldn't show its header and footer on this page, so the preview shows the page without them."

export interface SiteChromeToggleProps {
  enabled: boolean
  onToggle: () => void
  /** On, but the page with the header and footer never connected; see `PreviewPane`. */
  failed?: boolean
}

/** Shows and hides the site's header and footer around the previewed page. */
export function SiteChromeToggle({ enabled, onToggle, failed = false }: SiteChromeToggleProps) {
  const noteId = useId()
  return (
    <Tooltip
      label={failed ? `${SITE_CHROME_LABEL}. ${SITE_CHROME_FAILED_NOTE}` : SITE_CHROME_LABEL}
      multiline
      maw={280}
    >
      <ActionIcon
        variant={enabled ? 'filled' : 'subtle'}
        color={enabled ? 'brand' : 'gray'}
        size="md"
        aria-pressed={enabled}
        aria-label={SITE_CHROME_LABEL}
        aria-describedby={failed ? noteId : undefined}
        data-testid="toggle-site-chrome-button"
        onClick={onToggle}
      >
        <IconLayoutNavbar size={16} />
        {failed && <VisuallyHidden id={noteId}>{SITE_CHROME_FAILED_NOTE}</VisuallyHidden>}
      </ActionIcon>
    </Tooltip>
  )
}

const LISTED = 3

// Module-level, so React never re-calls it on a re-render and pulls focus back while closing.
const focusOnMount = (node: HTMLElement | null) => node?.focus()

const markList = (marks: readonly InexactMark[]): string =>
  marks
    .slice(0, LISTED)
    .map((mark) => mark.path || '""')
    .join(', ')

/** The admin's count of preview marks that name no field of the entry; see `findInexactMarks`. */
export function UnmappedMarksChip({ marks }: { marks: readonly InexactMark[] }) {
  const [opened, setOpened] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  // Focus moves to Close as the dropdown mounts. Close and Escape hand it back to the chip; focus
  // leaving otherwise, Tab included, just closes it, so there is no focus trap.
  // Closed when the marks run out, so their return never reopens it and takes focus.
  if (marks.length === 0) {
    if (opened) setOpened(false)
    return null
  }
  const one = marks.length === 1
  const closeToChip = () => {
    setOpened(false)
    chipRef.current?.focus()
  }
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      closeOnEscape={false}
      width={300}
      position="bottom-end"
      withArrow
      shadow="md"
    >
      <Popover.Target>
        <UnstyledButton
          ref={chipRef}
          data-testid="preview-unmapped-chip"
          // A controlled Popover's target toggles nothing itself.
          // Pressed while open, it keeps focus in the dropdown, whose blur would close it first
          // and let this click reopen it.
          onMouseDown={(event) => {
            if (opened) event.preventDefault()
          }}
          onClick={() => (opened ? closeToChip() : setOpened(true))}
          style={{
            flexShrink: 0,
            borderRadius: 999,
            minHeight: 24,
            padding: '0 8px',
            fontSize: 'var(--mantine-font-size-xs)',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            color: 'var(--mantine-color-text)',
            background: 'var(--canopy-count-bg-orange)',
          }}
        >
          {marks.length} unmapped
          <VisuallyHidden> preview {one ? 'mark' : 'marks'}</VisuallyHidden>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown
        onKeyDown={(event) => {
          if (event.key === 'Escape') closeToChip()
        }}
        onBlur={(event) => {
          // Not when the window itself loses focus, such as to the browser's console.
          if (document.hasFocus() && !event.currentTarget.contains(event.relatedTarget)) {
            setOpened(false)
          }
        }}
      >
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Unmapped preview marks
          </Text>
          <Text size="sm">
            {one
              ? "One element on this page carries a field mark that doesn't match a field of this entry: "
              : `${marks.length} elements on this page carry field marks that don't match a field of this entry: `}
            <Text component="span" ff="monospace" size="xs" style={{ overflowWrap: 'anywhere' }}>
              {markList(marks)}
            </Text>
            {marks.length > LISTED ? `, and ${marks.length - LISTED} more` : ''}.{' '}
            {one
              ? "It's outlined, and clicking it focuses its nearest field, if it has one."
              : "They're outlined, and clicking one focuses its nearest field, if it has one."}
          </Text>
          <Text size="sm">
            The browser console names the nearest field of {one ? 'it' : 'each'}, for the
            site&apos;s developer to correct in its fieldProps.
          </Text>
          <Group justify="flex-end">
            <Button ref={focusOnMount} size="compact-sm" variant="default" onClick={closeToChip}>
              Close
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

const MAXIMIZE_LABEL = 'Maximize preview'

export interface MaximizeToggleProps {
  maximized: boolean
  onChange: (maximized: boolean) => void
  maximizeRef?: Ref<HTMLButtonElement>
  restoreRef?: Ref<HTMLButtonElement>
}

/** An icon to maximize; once maximized, a labelled Restore, which Esc also does. */
export function MaximizeToggle({
  maximized,
  onChange,
  maximizeRef,
  restoreRef,
}: MaximizeToggleProps) {
  return maximized ? (
    <Tooltip label="Show the form again · Esc">
      <Button
        ref={restoreRef}
        size="compact-sm"
        variant="default"
        leftSection={<IconArrowsMinimize size={14} />}
        aria-keyshortcuts="Escape"
        data-testid="preview-restore-button"
        onClick={() => onChange(false)}
      >
        Restore
      </Button>
    </Tooltip>
  ) : (
    <Tooltip label={MAXIMIZE_LABEL}>
      <ActionIcon
        ref={maximizeRef}
        variant="subtle"
        size="md"
        aria-label={MAXIMIZE_LABEL}
        data-testid="preview-maximize-button"
        onClick={() => onChange(true)}
      >
        <IconArrowsMaximize size={16} />
      </ActionIcon>
    </Tooltip>
  )
}
