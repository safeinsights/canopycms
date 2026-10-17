'use client'

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Button, Loader, Menu, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { useReducedMotion } from '@mantine/hooks'
import { IconAlertTriangle, IconCheck, IconChevronDown, IconLoader2 } from '@tabler/icons-react'
import { EDITOR_ACTIONS } from '../copy'
import type { SaveAllProgress } from '../hooks/save-all'
import { ReasonedMenuItem } from './ReasonedMenuItem'
import { useMenuItemFocusReturn } from '../utils/focus-return'

export interface SaveSplitButtonProps {
  onSave: () => void
  /** Why Save can't act now; empty when it can. */
  saveBlockedReason: string
  /** The editor is loading or saving: Save waits without a reason. */
  busy: boolean
  onSaveAll: () => void
  /** Entries on the branch with unsaved changes. */
  unsavedCount: number
  /** Why Save all can't act now, other than nothing being unsaved. */
  saveAllBlockedReason?: string
  /** Set while Save all runs. */
  saveAllProgress: SaveAllProgress | null
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

const STORAGE_FAILED_TEXT = 'Unsaved · not kept on this device'
const STORAGE_FAILED_HINT = "Save before you leave or reload, or they'll be lost."
const KEPT_HINT = 'Unsaved changes are kept on this device until you save.'
// Visually hidden, as Mantine's VisuallyHidden, for a region that must stay mounted.
const HIDDEN_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}
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
 * and the top bar never shifts.
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
 * Save with a caret offering "Save all". While the open entry has unsaved changes, Save's Tooltip
 * and description say they are kept on this device. Only when keeping them failed does the bar
 * carry a warning before Save, icon-only below `lg`, its text then its Tooltip and accessible name.
 */
export function SaveSplitButton({
  onSave,
  saveBlockedReason,
  busy,
  onSaveAll,
  unsavedCount,
  saveAllBlockedReason,
  saveAllProgress,
  saving = false,
  savedSignal,
  savedHere = false,
  entryDirty,
  draftStorageFailed,
}: SaveSplitButtonProps) {
  const caret = useRef<HTMLButtonElement>(null)
  const keptHintId = useId()
  const menuFocus = useMenuItemFocusReturn(caret)
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
  const saveBlocked = !!saveBlockedReason || busy || !!saveAllProgress
  const label: SaveLabel = saving
    ? 'saving'
    : flashing !== undefined &&
        flashing === savedSignal &&
        savedHere &&
        !entryDirty &&
        !saveAllProgress
      ? 'saved'
      : 'save'
  const saveGreyed = saveBlocked && !saveAllProgress && label === 'save'
  const storageWarning = entryDirty && draftStorageFailed
  // Why Save is blocked, else where unsaved changes are held; a blocked Save's reason leads.
  const keptHint = entryDirty && !draftStorageFailed && !saveBlockedReason ? KEPT_HINT : ''
  const saveTooltip = saveBlockedReason || keptHint

  return (
    <>
      {/* Always mounted so a warning is announced; visible, at a fixed width, only on failure. */}
      <Box
        role="status"
        ta="right"
        w={{ base: 20, lg: 112 }}
        style={storageWarning ? { flexShrink: 0 } : HIDDEN_STYLE}
      >
        {storageWarning && (
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
      <VisuallyHidden role="status">
        {saveAllProgress
          ? `Saving ${saveAllProgress.total} ${saveAllProgress.total === 1 ? 'entry' : 'entries'}…`
          : label === 'saved'
            ? 'Saved'
            : ''}
      </VisuallyHidden>
      {/* `hidden`, so browse mode doesn't read it a second time; `aria-describedby` still can. */}
      {keptHint && (
        <span hidden id={keptHintId}>
          {keptHint}
        </span>
      )}
      <style>{LABEL_STYLES}</style>
      <Button.Group style={{ flexShrink: 0 }}>
        <Tooltip
          label={saveTooltip}
          // Not beside "Saving…" or "Saved", which already say what happened.
          disabled={!saveTooltip || busy || label !== 'save'}
          multiline
          maw={280}
        >
          <Button
            data-testid="save-button"
            variant="filled"
            size="sm"
            leftSection={
              saveAllProgress && !reducedMotion ? (
                <Loader size={14} color="currentColor" />
              ) : undefined
            }
            onClick={() => {
              if (!saveBlocked) onSave()
            }}
            // A progress or "Saved" label stays readable: disabled styling takes it under 4.5:1.
            data-disabled={saveGreyed ? true : undefined}
            aria-disabled={saveBlocked ? true : undefined}
            // Never an explicit `undefined`: that would replace the Tooltip's own description.
            {...(keptHint ? { 'aria-describedby': keptHintId } : {})}
          >
            {saveAllProgress ? (
              `Saving ${Math.min(saveAllProgress.done + 1, saveAllProgress.total)} of ${saveAllProgress.total}…`
            ) : (
              <SaveLabels shown={label} spinner={!reducedMotion} />
            )}
          </Button>
        </Tooltip>
        <Menu withinPortal shadow="sm" position="bottom-end" {...menuFocus.menu}>
          <Tooltip label="Save options" events={{ hover: true, focus: true, touch: false }}>
            <Menu.Target>
              <Button
                ref={caret}
                // Light beside a greyed Save, so a blocked split button shows no filled half.
                variant={saveGreyed ? 'light' : 'filled'}
                size="sm"
                px={8}
                aria-label="Save options"
                data-testid="save-options-button"
                style={{ borderInlineStart: '1px solid var(--mantine-color-body)' }}
              >
                <IconChevronDown size={14} aria-hidden="true" />
              </Button>
            </Menu.Target>
          </Tooltip>
          <Menu.Dropdown {...menuFocus.dropdown}>
            <ReasonedMenuItem
              data-testid="save-all-menu-item"
              onClick={onSaveAll}
              blockedReason={
                saveAllBlockedReason ??
                (saveAllProgress
                  ? `${EDITOR_ACTIONS.saveAll} is already running.`
                  : unsavedCount === 0
                    ? 'No entry on this branch has unsaved changes.'
                    : busy
                      ? 'Wait for the current save or load to finish.'
                      : undefined)
              }
            >
              {unsavedCount > 0
                ? `${EDITOR_ACTIONS.saveAll} (${unsavedCount})`
                : EDITOR_ACTIONS.saveAll}
            </ReasonedMenuItem>
          </Menu.Dropdown>
        </Menu>
      </Button.Group>
    </>
  )
}
