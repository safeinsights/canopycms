'use client'

import React, { type Ref } from 'react'
import { Box, Group } from '@mantine/core'
import type { BranchStatus } from '../../types'
import type { EditorEntry } from '../Editor'
import type { BreadcrumbSegment } from '../editor-utils'
import { SHELL_REGION_BORDER } from '../shell/EditorShell'
import { describeBranchLock } from './BranchLockBanner'
import { EntryBreadcrumb } from './EntryBreadcrumb'
import { EntrySaveButton } from './EntrySaveButton'

export const ENTRY_HEADER_HEIGHT = 48

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
  /** The entry menu's trigger. */
  navigatorToggleRef?: Ref<HTMLButtonElement>
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
}

/** The open entry's breadcrumb, menu, unsaved dot and "Read-only" chip, then Save, over the panes. */
export function EntryHeader({
  currentEntry,
  entryLoading = false,
  branchName,
  busy,
  breadcrumbSegments,
  onCollectionOpen,
  navigatorToggleRef,
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
}: EntryHeaderProps) {
  // Set exactly when BranchLockBanner renders.
  const branchLockReason = describeBranchLock({ branchStatus, branchReadOnly, branchWriteBlocked })
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
      py={6}
      mih={ENTRY_HEADER_HEIGHT}
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
          // BranchLockBanner already says why a locked branch is read-only, so the chip carries
          // only the entry's own reason, even beside the banner: "Withdraw it" would not unlock it.
          readOnlyReason={
            branchLoading ? undefined : currentEntry || branchName ? entryLockReason : undefined
          }
          onCollection={onCollectionOpen}
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
