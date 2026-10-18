'use client'

import React, { useEffect, useId, useState } from 'react'
import { Box, Button, Loader, Tooltip, VisuallyHidden } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { IconCheck, IconLoader2 } from '@tabler/icons-react'
import { EDITOR_ACTIONS } from '../copy'

export interface EntrySaveButtonProps {
  onSave: () => void
  /** Why Save can't act now; empty when it can. */
  saveBlockedReason: string
  /** The editor is loading or saving: Save waits without a reason. */
  busy: boolean
  /** Save all is running, so Save waits for it, and says so. */
  saveAllRunning: boolean
  /** A Save of the open entry is in flight. */
  saving?: boolean
  /** Rises each time a single Save lands, whichever entry it saved. */
  savedSignal?: number
  /** The last Save that landed saved the open entry. */
  savedHere?: boolean
  /** The open entry has unsaved changes. */
  entryDirty: boolean
  /** Writing drafts to localStorage failed, so they live only in this tab. */
  draftStorageFailed: boolean
}

const KEPT_HINT = 'Unsaved changes are kept on this device until you save.'
const SAVE_ALL_WAIT = 'Wait for Save all to finish.'
const SAVED_SHOWN_MS = 2000

type SaveLabel = 'save' | 'saving' | 'saved'

// Below `sm` the status words are visually hidden, so Save keeps its own width beside an icon.
const LABEL_TEXT_CLASS = 'canopy-save-label-text'
const LABEL_STYLES = `
@media (max-width: 47.99em) {
  .${LABEL_TEXT_CLASS} {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap;
  }
}
`

/**
 * Every label in one grid cell, only `shown` visible, so the button keeps the widest one's width
 * and the header never shifts.
 */
function SaveLabels({ shown, spinner }: { shown: SaveLabel; spinner: boolean }) {
  const labels: Record<SaveLabel, React.ReactNode> = {
    save: EDITOR_ACTIONS.save,
    saving: (
      <>
        <Box component="span" display="inline-flex" w={14}>
          {shown === 'saving' &&
            (spinner ? (
              <Loader size={14} color="currentColor" />
            ) : (
              <IconLoader2 size={14} aria-hidden="true" />
            ))}
        </Box>
        <span className={LABEL_TEXT_CLASS}>Saving…</span>
      </>
    ),
    saved: (
      <>
        <IconCheck size={14} aria-hidden="true" />
        <span className={LABEL_TEXT_CLASS}>Saved</span>
      </>
    ),
  }
  return (
    <Box component="span" pos="relative" style={{ display: 'inline-grid' }}>
      {(Object.keys(labels) as SaveLabel[]).map((key) => (
        <Box
          key={key}
          component="span"
          aria-hidden={key === shown ? undefined : true}
          style={{
            gridArea: '1 / 1',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            visibility: key === shown ? 'visible' : 'hidden',
          }}
        >
          {labels[key]}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The open entry's Save, reading "Saving…" then "Saved" as a save lands. While the entry has
 * unsaved changes, its Tooltip and description say they are kept on this device.
 */
export function EntrySaveButton({
  onSave,
  saveBlockedReason,
  busy,
  saveAllRunning,
  saving = false,
  savedSignal,
  savedHere = false,
  entryDirty,
  draftStorageFailed,
}: EntrySaveButtonProps) {
  const keptHintId = useId()
  const reducedMotion = useReducedMotion()
  // Each landed Save shows "Saved" once, as it lands and only on its own entry: one that landed
  // before mount or while another entry was open shows nothing later.
  const [seenSignal, setSeenSignal] = useState(savedSignal ?? 0)
  const [flashing, setFlashing] = useState<number>()
  // Leaving the saved entry ends its "Saved", so a quick return doesn't show or announce it again.
  const [wasHere, setWasHere] = useState(savedHere)
  if (wasHere !== savedHere) {
    setWasHere(savedHere)
    if (!savedHere) setFlashing(undefined)
  }
  if (savedSignal !== undefined && savedSignal > seenSignal) {
    setSeenSignal(savedSignal)
    setFlashing(savedHere ? savedSignal : undefined)
  }
  useEffect(() => {
    if (flashing === undefined) return
    const timer = setTimeout(() => setFlashing(undefined), SAVED_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [flashing])
  // Blocked, Save stays focusable (`aria-disabled`, not `disabled`), so its reason opens on focus.
  const saveBlocked = !!saveBlockedReason || busy || saveAllRunning
  const label: SaveLabel = saving
    ? 'saving'
    : flashing !== undefined &&
        flashing === savedSignal &&
        savedHere &&
        !entryDirty &&
        !saveAllRunning
      ? 'saved'
      : 'save'
  // A "Saving…" or "Saved" label stays readable: disabled styling takes it under 4.5:1.
  const saveGreyed = saveBlocked && label === 'save'
  const blockedReason = saveAllRunning ? SAVE_ALL_WAIT : saveBlockedReason
  // Why Save is blocked, else where unsaved changes are held; a blocked Save's reason leads.
  const keptHint = entryDirty && !draftStorageFailed && !blockedReason ? KEPT_HINT : ''
  const saveTooltip = blockedReason || keptHint

  return (
    <>
      <VisuallyHidden role="status">{label === 'saved' ? 'Saved' : ''}</VisuallyHidden>
      {/* `hidden`, so browse mode doesn't read it a second time; `aria-describedby` still can. */}
      {keptHint && (
        <span hidden id={keptHintId}>
          {keptHint}
        </span>
      )}
      <style>{LABEL_STYLES}</style>
      <Tooltip
        label={saveTooltip}
        // Not beside "Saving…" or "Saved", nor while busy, except Save all's wait: its reloads flip `busy`.
        disabled={!saveTooltip || label !== 'save' || (busy && !saveAllRunning)}
        multiline
        maw={280}
      >
        <Button
          data-testid="save-button"
          variant="filled"
          size="sm"
          style={{ flexShrink: 0 }}
          onClick={() => {
            if (!saveBlocked) onSave()
          }}
          data-disabled={saveGreyed ? true : undefined}
          aria-disabled={saveBlocked ? true : undefined}
          // Never an explicit `undefined`: that would replace the Tooltip's own description.
          {...(keptHint ? { 'aria-describedby': keptHintId } : {})}
        >
          <SaveLabels shown={label} spinner={!reducedMotion} />
        </Button>
      </Tooltip>
    </>
  )
}
