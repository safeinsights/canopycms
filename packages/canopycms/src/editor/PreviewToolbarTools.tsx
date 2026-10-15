'use client'

import type { Ref } from 'react'
import { useId } from 'react'

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
  IconLayoutColumns,
  IconLayoutRows,
  IconMarquee,
} from '@tabler/icons-react'

import type { InexactMark } from './preview-marks'
import type { PaneArrangement } from './shell/PaneLayout'

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

const LISTED = 3

const markList = (marks: readonly InexactMark[]): string =>
  marks
    .slice(0, LISTED)
    .map((mark) => mark.path || '""')
    .join(', ')

/** The admin's count of preview marks that name no field of the entry; see `findInexactMarks`. */
export function UnmappedMarksChip({ marks }: { marks: readonly InexactMark[] }) {
  if (marks.length === 0) return null
  const one = marks.length === 1
  return (
    // Focus moves in, so Escape and Tab out close it and return focus to the chip.
    <Popover width={300} position="bottom-end" withArrow shadow="md" trapFocus returnFocus>
      <Popover.Target>
        <UnstyledButton
          data-testid="preview-unmapped-chip"
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
      <Popover.Dropdown>
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
              ? "It's outlined, but clicking it focuses no field."
              : "They're outlined, but clicking one focuses no field."}
          </Text>
          <Text size="sm">
            The browser console names the nearest field of {one ? 'it' : 'each'}, for the
            site&apos;s developer to correct in its fieldProps.
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

const LAYOUTS: { value: PaneArrangement; label: string; Icon: typeof IconLayoutColumns }[] = [
  { value: 'side', label: 'Side by side', Icon: IconLayoutColumns },
  { value: 'stacked', label: 'Stacked', Icon: IconLayoutRows },
]

const LAYOUT_BLOCKED = 'Restore the preview to change the layout.'

export interface LayoutToggleProps {
  layout: PaneArrangement
  onChange: (layout: PaneArrangement) => void
  /** The preview is maximized, so the layout has nothing to arrange. */
  blocked?: boolean
}

/** The form/preview arrangement as a pair of pressed buttons, so the current one shows. */
export function LayoutToggle({ layout, onChange, blocked = false }: LayoutToggleProps) {
  const reasonId = useId()
  return (
    <Group role="group" aria-label="Layout" gap={2} wrap="nowrap">
      {LAYOUTS.map(({ value, label, Icon }) => (
        <Tooltip key={value} label={blocked ? LAYOUT_BLOCKED : label}>
          <ActionIcon
            variant={layout === value ? 'filled' : 'subtle'}
            color={layout === value ? 'brand' : 'gray'}
            size="md"
            aria-label={label}
            aria-pressed={layout === value}
            aria-disabled={blocked || undefined}
            aria-describedby={blocked ? reasonId : undefined}
            data-disabled={blocked || undefined}
            data-testid={`preview-layout-${value}`}
            onClick={() => {
              if (!blocked) onChange(value)
            }}
          >
            <Icon size={16} />
          </ActionIcon>
        </Tooltip>
      ))}
      {blocked && <VisuallyHidden id={reasonId}>{LAYOUT_BLOCKED}</VisuallyHidden>}
    </Group>
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
