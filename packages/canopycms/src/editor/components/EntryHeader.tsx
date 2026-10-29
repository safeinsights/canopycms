'use client'

import React, { type Ref } from 'react'
import {
  ActionIcon,
  Box,
  Button,
  em,
  getBreakpointValue,
  Group,
  Tooltip,
  useMantineTheme,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconArrowsDiff } from '@tabler/icons-react'
import type { BranchStatus } from '../../types'
import type { EditorEntry } from '../Editor'
import type { BreadcrumbSegment } from '../editor-utils'
import { SHELL_HEADER_HEIGHT, SHELL_REGION_BORDER } from '../shell/EditorShell'
import { describeBranchLock } from '../branch-lock'
import { EDITOR_ACTIONS } from '../copy'
import { EntryBreadcrumb } from './EntryBreadcrumb'
import { EntrySaveButton } from './EntrySaveButton'

export interface EntryHeaderProps {
  currentEntry: EditorEntry | undefined
  /** No entry yet because the branch or its entries are still loading. */
  entryLoading?: boolean
  branchName: string
  /** Whether operations are currently in progress. */
  busy: boolean
  /** The crumbs before the open entry's own. */
  breadcrumbSegments: BreadcrumbSegment[]
  /** Opens the content panel on a collection. */
  onCollectionOpen: (collectionPath: string) => void
  /** Opens the content panel on the open entry's row. */
  onEntryReveal?: () => void
  /** The entry menu's trigger. */
  navigatorToggleRef?: Ref<HTMLButtonElement>
  /** Opens the open entry's changes against the base; offered only while it has some. */
  onShowChanges?: () => void
  /**
   * Hold the Show changes slot, unseen, when there is no `onShowChanges`: while the changes list
   * loads, or for an entry with no changes, so the header never shifts between them.
   */
  showChangesPending?: boolean
  showChangesRef?: Ref<HTMLButtonElement>
  /** Replaces the open entry with the server's copy. */
  onFileReload: () => void
  onFileDiscardDraft: () => void
  /** Opens the open entry's "Change URL" dialog. */
  onEntryRename: () => void
  /** Asks to delete the open entry. */
  onEntryDelete: () => void
  onSave: () => void
  /** Save all is running. */
  saveAllRunning: boolean
  /** A Save of the open entry is in flight. */
  saving?: boolean
  /** Rises each time a single Save lands, whichever entry it saved. */
  savedSignal?: number
  /** The last Save that landed saved the open entry. */
  savedHere?: boolean
  /** The open entry has unsaved changes it could save. */
  hasUnsavedChanges: boolean
  /** The open entry has a draft, savable or not (a read-only branch's still discards). */
  entryHasDraft?: boolean
  /** Writing drafts to localStorage failed, so they live only in this tab. */
  draftStorageFailed?: boolean
  /** The open entry can't be edited by this user (a path rule). */
  entryReadOnly?: boolean
  /** The open entry's type has no schema in the running code. */
  entryUnavailable?: boolean
  /** Current branch status (undefined if unknown). */
  branchStatus: BranchStatus | undefined
  /** Whether the current branch is read-only (protected base branch in prod); disables Save. */
  branchReadOnly?: boolean
  /** Server-computed: content writes are rejected on this branch; see `branchLockState`. */
  branchWriteBlocked?: boolean
  /** No branch details yet: the fail-closed lock defaults are guesses the chip doesn't name. */
  branchLoading?: boolean
  /** The branch list is still being fetched, so Save waits rather than naming a failure. */
  branchPending?: boolean
  /** The branch list answered without this branch. */
  branchMissing?: boolean
}

/**
 * "Show changes": a subtle text button, icon-only below `sm`. Without `onClick` it holds its
 * place unseen while the changes list loads, so nothing beside it moves when it appears.
 */
const ShowChangesButton: React.FC<{ onClick?: () => void; buttonRef?: Ref<HTMLButtonElement> }> = ({
  onClick,
  buttonRef,
}) => {
  const theme = useMantineTheme()
  const narrow =
    useMediaQuery(`(max-width: ${em(getBreakpointValue('sm', theme.breakpoints) - 0.1)})`, false, {
      getInitialValueInEffect: false,
    }) === true
  const placeholder = !onClick
  const hold = placeholder
    ? { 'aria-hidden': true, tabIndex: -1, style: { visibility: 'hidden' as const, flexShrink: 0 } }
    : { style: { flexShrink: 0 } }
  const icon = <IconArrowsDiff size={14} aria-hidden />
  if (narrow) {
    return (
      <Tooltip
        label={EDITOR_ACTIONS.showChanges}
        position="bottom"
        events={{ hover: true, focus: true, touch: false }}
        disabled={placeholder}
      >
        <ActionIcon
          ref={placeholder ? undefined : buttonRef}
          size="md"
          variant="subtle"
          aria-label={EDITOR_ACTIONS.showChanges}
          onClick={onClick}
          data-testid={placeholder ? 'entry-show-changes-pending' : 'entry-show-changes'}
          {...hold}
        >
          {icon}
        </ActionIcon>
      </Tooltip>
    )
  }
  return (
    <Button
      ref={placeholder ? undefined : buttonRef}
      size="compact-sm"
      variant="subtle"
      leftSection={icon}
      onClick={onClick}
      data-testid={placeholder ? 'entry-show-changes-pending' : 'entry-show-changes'}
      {...hold}
    >
      {EDITOR_ACTIONS.showChanges}
    </Button>
  )
}

/** The open entry's breadcrumb, menu, unsaved dot and "Read-only" chip, then Save, over the panes. */
export function EntryHeader({
  currentEntry,
  entryLoading = false,
  branchName,
  busy,
  breadcrumbSegments,
  onCollectionOpen,
  onEntryReveal,
  navigatorToggleRef,
  onShowChanges,
  showChangesPending = false,
  showChangesRef,
  onFileReload,
  onFileDiscardDraft,
  onEntryRename,
  onEntryDelete,
  onSave,
  saveAllRunning,
  saving = false,
  savedSignal,
  savedHere = false,
  hasUnsavedChanges,
  entryHasDraft = hasUnsavedChanges,
  draftStorageFailed = false,
  entryReadOnly = false,
  entryUnavailable = false,
  branchStatus,
  branchReadOnly = false,
  branchWriteBlocked = false,
  branchLoading = false,
  branchPending = false,
  branchMissing = false,
}: EntryHeaderProps) {
  const branchLockReason = describeBranchLock({
    branchStatus,
    branchReadOnly,
    branchWriteBlocked,
    branchPending,
    branchMissing,
  })
  const entryLockReason = entryReadOnly
    ? "You don't have edit access to this entry. Ask a CanopyCMS admin to grant it."
    : undefined
  // The Tooltip hides it while the editor is busy.
  const saveBlockedReason =
    branchLockReason ??
    (!branchName
      ? 'Open a branch first.'
      : !currentEntry
        ? 'Open an entry to save it.'
        : (entryLockReason ?? (!hasUnsavedChanges ? 'No changes to save.' : '')))

  return (
    <Group
      component="section"
      aria-label="Entry"
      data-testid="entry-header"
      gap="xs"
      wrap="nowrap"
      justify="space-between"
      px="sm"
      h={SHELL_HEADER_HEIGHT}
      style={{
        flexShrink: 0,
        borderBottom: SHELL_REGION_BORDER,
        background: 'var(--mantine-color-body)',
      }}
    >
      <Box miw={0} style={{ flex: '1 1 0%' }}>
        <EntryBreadcrumb
          segments={breadcrumbSegments}
          entryLabel={currentEntry ? (currentEntry.label ?? currentEntry.slug) : undefined}
          entryLoading={entryLoading}
          entryDirty={hasUnsavedChanges}
          // The branch bar's status already says a locked branch is read-only, so the chip carries
          // only the entry's own reason: "Withdraw it" would not unlock the entry.
          readOnlyReason={
            branchLoading ? undefined : currentEntry || branchName ? entryLockReason : undefined
          }
          onCollection={onCollectionOpen}
          onReveal={onEntryReveal}
          onRefresh={onFileReload}
          onDiscard={onFileDiscardDraft}
          // A path rule's refusal hides them, as the content tree hides that entry's "…" menu.
          onRename={entryReadOnly ? undefined : onEntryRename}
          // An entry with a page has a preview `src`; one without changes only its slug.
          entryNoPage={!!currentEntry && !currentEntry.previewSrc}
          onDelete={entryReadOnly ? undefined : onEntryDelete}
          refreshBlockedReason={branchName ? undefined : 'Open a branch first.'}
          discardBlockedReason={entryHasDraft ? undefined : 'This entry has no unsaved changes.'}
          changeBlockedReason={
            branchLockReason ??
            (entryUnavailable
              ? "This entry's content type isn't known to this editor version yet. Reload in a few minutes."
              : undefined)
          }
          entryMenuRef={navigatorToggleRef}
        />
      </Box>
      {(onShowChanges || showChangesPending) && (
        <ShowChangesButton onClick={onShowChanges} buttonRef={showChangesRef} />
      )}
      <EntrySaveButton
        onSave={onSave}
        saveBlockedReason={saveBlockedReason}
        // Loading, "Open an entry to save it." would claim an empty state too soon.
        busy={busy || entryLoading}
        saveAllRunning={saveAllRunning}
        saving={saving}
        savedSignal={savedSignal}
        savedHere={savedHere}
        entryDirty={hasUnsavedChanges}
        draftStorageFailed={draftStorageFailed}
      />
    </Group>
  )
}
