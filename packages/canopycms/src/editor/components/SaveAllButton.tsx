'use client'

import React from 'react'
import { Box, Button, Loader, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { IconAlertTriangle } from '@tabler/icons-react'
import { EDITOR_ACTIONS } from '../copy'
import type { SaveAllProgress } from '../hooks/save-all'

export interface SaveAllButtonProps {
  onSaveAll: () => void
  /** Entries on the branch with unsaved changes. */
  unsavedCount: number
  /** Why Save all can't act now, other than its own run, a save in flight or nothing unsaved. */
  blockedReason?: string
  /** Set while Save all runs. */
  saveAllProgress: SaveAllProgress | null
  /** A single Save is in flight, on any entry; Save all can't start beside it. */
  singleSaving: boolean
  /** The editor is loading or saving. */
  busy: boolean
}

/**
 * Every label in one grid cell, only `shown` visible, so the button keeps the widest one's width
 * and the top bar doesn't shift as the count or progress changes.
 */
function SaveAllLabels({ shown, labels }: { shown: number; labels: React.ReactNode[] }) {
  return (
    <Box component="span" style={{ display: 'inline-grid' }}>
      {labels.map((label, index) => (
        <Box
          key={index}
          component="span"
          aria-hidden={index === shown ? undefined : true}
          style={{
            gridArea: '1 / 1',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            visibility: index === shown ? 'visible' : 'hidden',
          }}
        >
          {label}
        </Box>
      ))}
    </Box>
  )
}

/** Saves every unsaved entry on the branch; the result is a toast (`SaveAllResult`). */
export function SaveAllButton({
  onSaveAll,
  unsavedCount,
  blockedReason,
  saveAllProgress,
  singleSaving,
  busy,
}: SaveAllButtonProps) {
  const reducedMotion = useReducedMotion()
  // A running Save all shows only its progress: a lock arriving mid-run would grey it.
  const reason = saveAllProgress
    ? undefined
    : (blockedReason ??
      (singleSaving
        ? 'Wait for the save to finish.'
        : unsavedCount === 0
          ? 'No entry on this branch has unsaved changes.'
          : busy
            ? 'Wait for the current save or load to finish.'
            : undefined))
  // Blocked, it stays focusable (`aria-disabled`, not `disabled`), so its reason opens on focus.
  const blocked = !!reason || !!saveAllProgress
  // The widest each label gets for this many entries, held in place while another shows.
  const total = saveAllProgress?.total ?? Math.max(unsavedCount, 1)
  const progressText = (done: number) => `Saving ${Math.min(done + 1, total)} of ${total}…`
  const labels = [
    unsavedCount > 0 ? `${EDITOR_ACTIONS.saveAll} (${unsavedCount})` : EDITOR_ACTIONS.saveAll,
    `${EDITOR_ACTIONS.saveAll} (${Math.max(unsavedCount, 1)})`,
    <>
      <Box component="span" display="inline-flex" w={14}>
        {saveAllProgress && !reducedMotion && <Loader size={14} color="currentColor" />}
      </Box>
      {progressText(saveAllProgress ? saveAllProgress.done : total)}
    </>,
  ]

  return (
    <>
      <VisuallyHidden role="status">
        {saveAllProgress
          ? `Saving ${saveAllProgress.total} ${saveAllProgress.total === 1 ? 'entry' : 'entries'}…`
          : ''}
      </VisuallyHidden>
      <Tooltip
        label={reason}
        disabled={!reason}
        multiline
        maw={300}
        // Down, beside the entry header's Save, whose reasons also open down.
        position="bottom-end"
      >
        <Button
          data-testid="save-all-button"
          // The open entry's Save is the editor's one filled primary.
          variant="light"
          size="sm"
          style={{ flexShrink: 0 }}
          onClick={() => {
            if (!blocked) onSaveAll()
          }}
          // The progress label stays readable: disabled styling takes it under 4.5:1.
          data-disabled={reason ? true : undefined}
          aria-disabled={blocked ? true : undefined}
        >
          <SaveAllLabels shown={saveAllProgress ? 2 : 0} labels={labels} />
        </Button>
      </Tooltip>
    </>
  )
}

const STORAGE_FAILED_TEXT = 'Unsaved · not kept on this device'
const STORAGE_FAILED_HINT = "Save before you leave or reload, or they'll be lost."
// Visually hidden, as Mantine's VisuallyHidden, for a region that must stay mounted.
const HIDDEN_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

/** Unsaved changes live only in this tab. Icon-only below `lg`, its text then its Tooltip. */
export function DraftStorageWarning({ shown }: { shown: boolean }) {
  return (
    // Always mounted so the warning is announced; visible, at a fixed width, only when shown.
    <Box
      role="status"
      ta="right"
      w={{ base: 20, lg: 112 }}
      style={shown ? { flexShrink: 0 } : HIDDEN_STYLE}
    >
      {shown && (
        <Tooltip label={`${STORAGE_FAILED_TEXT}. ${STORAGE_FAILED_HINT}`} multiline w={260}>
          <Text size="xs" lh={1.2} c="var(--canopy-danger-text)" data-testid="unsaved-indicator">
            <Box component="span" visibleFrom="lg">
              {STORAGE_FAILED_TEXT}
            </Box>
            <Box component="span" hiddenFrom="lg" display="inline-flex" aria-hidden="true">
              <IconAlertTriangle size={18} />
            </Box>
            <VisuallyHidden component="span" hiddenFrom="lg">
              {STORAGE_FAILED_TEXT}
            </VisuallyHidden>
            <VisuallyHidden component="span">. {STORAGE_FAILED_HINT}</VisuallyHidden>
          </Text>
        </Tooltip>
      )}
    </Box>
  )
}
