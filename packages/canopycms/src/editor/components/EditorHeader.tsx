import React, { type Ref } from 'react'
import { Button, Tooltip } from '@mantine/core'
import type { OperatingMode } from '../../operating-mode'
import type { BranchStatus } from '../../types'
import type { EditorEntry } from '../Editor'
import type { LogicalPath } from '../../paths/types'
import type { BreadcrumbSegment } from '../editor-utils'
import type { SaveAllProgress } from '../hooks/save-all'
import { clientOperatingStrategy } from '../../operating-mode/client'
import { isAdmin, isLockedOutOfBranch, isReviewer } from '../../authorization/helpers'
import { branchStatusPresentation } from '../branch-status'
import { EDITOR_ACTIONS } from '../copy'
import { SYSTEM_USER_ID } from '../../system-users'
import { TopBar } from '../shell/TopBar'
import { branchLockState } from './BranchLockBanner'
import { BranchPill } from './BranchPill'
import { EntryBreadcrumb } from './EntryBreadcrumb'
import { SaveSplitButton } from './SaveSplitButton'

export interface EditorHeaderProps {
  currentEntry: EditorEntry | undefined
  branchName: string
  operatingMode: OperatingMode
  /** Whether operations are currently in progress. */
  busy: boolean
  /** The crumbs before the open entry's own. */
  breadcrumbSegments: BreadcrumbSegment[]
  /** The listed entries with unsaved changes on the branch. */
  editedFiles: Array<{ path: LogicalPath; label: string }>
  /** Entries with unsaved changes on the branch. */
  modifiedCount: number
  /** Opens the content panel on a collection. */
  onCollectionOpen: (collectionPath: string) => void
  /** The entry menu's trigger. */
  navigatorToggleRef?: Ref<HTMLButtonElement>
  /** The branch pill. */
  branchToggleRef?: Ref<HTMLButtonElement>
  /** Replaces the open entry with the server's copy. */
  onFileReload: () => void
  onFileDiscardDraft: () => void
  /** Opens the open entry's "Change URL" dialog. */
  onEntryRename: () => void
  /** Asks to delete the open entry. */
  onEntryDelete: () => void
  onEntrySelect: (path: LogicalPath) => void
  /** Re-reads the branch and its entry list, keeping drafts. */
  onBranchReloadData: () => void
  onBranchDiscardDrafts: () => void
  onBranchManagerOpen: () => void
  onSave: () => void
  onSaveAll: () => void
  saveAllProgress: SaveAllProgress | null
  /** A Save of the open entry is in flight. */
  saving?: boolean
  /** Rises each time a single Save lands, whichever entry it saved. */
  savedSignal?: number
  /** The last Save that landed saved the open entry. */
  savedHere?: boolean
  /** The branch's entry list failed to load and none is held. */
  entryListFailed?: boolean
  onSubmit: () => void
  onWithdraw: () => void
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
  /** Current user context for permission checks. */
  userContext?: { userId: string; groups?: string[] }
  branchCreatedBy?: string
  branchAccess?: {
    allowedUsers?: string[]
    allowedGroups?: string[]
    managerOrAdminAllowed?: boolean
  }
  /**
   * Whether the current branch is the protected base branch (see
   * authorization/protected-branch.ts). Hides the Submit button (Withdraw
   * stays, as the recovery path). Default false.
   */
  branchIsProtected?: boolean
  /** Whether the current branch is read-only (protected base branch in prod); disables Save. */
  branchReadOnly?: boolean
  /** Server-computed: content writes are rejected on this branch; see `branchLockState`. */
  branchWriteBlocked?: boolean
  /**
   * No branch details yet (loading, or the list failed and the banner says so): the fail-closed
   * lock defaults are guesses, so neither the chip nor the status names them.
   */
  branchLoading?: boolean
}

/**
 * The top bar's contents: the breadcrumb with the entry menu and "Read-only" chip, then the branch
 * pill, Submit or Withdraw, and Save with Save all.
 */
export function EditorHeader({
  currentEntry,
  branchName,
  operatingMode,
  busy,
  breadcrumbSegments,
  editedFiles,
  modifiedCount,
  onCollectionOpen,
  navigatorToggleRef,
  branchToggleRef,
  onFileReload,
  onFileDiscardDraft,
  onEntryRename,
  onEntryDelete,
  onEntrySelect,
  onBranchReloadData,
  onBranchDiscardDrafts,
  onBranchManagerOpen,
  onSave,
  onSaveAll,
  saveAllProgress,
  saving = false,
  savedSignal,
  savedHere = false,
  entryListFailed = false,
  onSubmit,
  onWithdraw,
  hasUnsavedChanges,
  entryHasDraft = hasUnsavedChanges,
  draftStorageFailed = false,
  entryReadOnly = false,
  entryUnavailable = false,
  branchStatus,
  userContext,
  branchCreatedBy,
  branchAccess,
  branchIsProtected = false,
  branchReadOnly = false,
  branchWriteBlocked = false,
  branchLoading = false,
}: EditorHeaderProps) {
  const { statusLocked, branchDataUnavailable } = branchLockState({
    branchStatus,
    branchReadOnly,
    branchWriteBlocked,
  })

  // Why the branch takes no writes, with the way forward; shared by Save, Save all and the chip.
  const branchLockReason = branchReadOnly
    ? 'The base branch is read-only. Create a branch to make changes.'
    : branchDataUnavailable
      ? 'Branch details could not be loaded. Use "Switch branch…" to retry.'
      : statusLocked
        ? branchStatus === 'submitted'
          ? 'This branch is in review. Withdraw it to make changes.'
          : branchStatus === 'approved'
            ? 'This branch is approved. Withdraw it to make changes.'
            : `This branch is ${branchStatus}. Its content is read-only.`
        : undefined
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

  const presentation = branchStatusPresentation(branchStatus, branchIsProtected)
  const status =
    !branchLoading &&
    clientOperatingStrategy(operatingMode ?? 'prod').supportsStatusBadge() &&
    presentation
      ? {
          label: presentation.label,
          value: branchIsProtected ? 'protected' : String(branchStatus),
          testId: `header-status-badge-${branchIsProtected ? 'protected' : branchStatus}`,
        }
      : undefined

  return (
    <TopBar
      leading={
        <EntryBreadcrumb
          segments={breadcrumbSegments}
          entryLabel={currentEntry ? (currentEntry.label ?? currentEntry.slug) : undefined}
          entryDirty={hasUnsavedChanges}
          readOnlyReason={
            branchLoading
              ? undefined
              : currentEntry || branchName
                ? (branchLockReason ?? entryLockReason)
                : undefined
          }
          onCollection={onCollectionOpen}
          onRefresh={onFileReload}
          onDiscard={onFileDiscardDraft}
          // A path rule's refusal hides them, as the content tree hides that entry's "…" menu.
          onRename={entryReadOnly ? undefined : onEntryRename}
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
      }
      trailing={
        <>
          <BranchPill
            branchName={branchName}
            loading={busy}
            status={status}
            unsavedCount={modifiedCount}
            unsavedEntries={editedFiles}
            onSwitchBranch={onBranchManagerOpen}
            onRefreshBranch={onBranchReloadData}
            onDiscardAll={onBranchDiscardDrafts}
            onEntrySelect={onEntrySelect}
            pillRef={branchToggleRef}
          />
          <WorkflowButton
            branchName={branchName}
            busy={busy}
            branchStatus={branchStatus}
            userContext={userContext}
            branchCreatedBy={branchCreatedBy}
            branchAccess={branchAccess}
            branchIsProtected={branchIsProtected}
            onSubmit={onSubmit}
            onWithdraw={onWithdraw}
            savingAll={!!saveAllProgress}
          />
          <SaveSplitButton
            onSave={onSave}
            saveBlockedReason={saveBlockedReason}
            busy={busy}
            onSaveAll={onSaveAll}
            unsavedCount={modifiedCount}
            saveAllBlockedReason={
              branchLockReason ??
              (!branchName
                ? 'Open a branch first.'
                : entryListFailed && modifiedCount > 0
                  ? 'The list of entries couldn\'t be loaded, so these changes can\'t be saved yet. Choose "Refresh branch" in the branch menu to try again.'
                  : undefined)
            }
            saveAllProgress={saveAllProgress}
            saving={saving}
            savedSignal={savedSignal}
            savedHere={savedHere}
            entryDirty={hasUnsavedChanges}
            draftStorageFailed={draftStorageFailed}
          />
        </>
      }
    />
  )
}

type WorkflowButtonProps = Pick<
  EditorHeaderProps,
  | 'branchName'
  | 'busy'
  | 'branchStatus'
  | 'userContext'
  | 'branchCreatedBy'
  | 'branchAccess'
  | 'onSubmit'
  | 'onWithdraw'
> & { branchIsProtected: boolean; savingAll: boolean }

/** Submit for review, or Withdraw from review once submitted or approved. */
function WorkflowButton({
  branchName,
  busy,
  branchStatus,
  userContext,
  branchCreatedBy,
  branchAccess,
  branchIsProtected,
  onSubmit,
  onWithdraw,
  savingAll,
}: WorkflowButtonProps) {
  const isSubmitted = branchStatus === 'submitted'
  const isEditing = branchStatus === 'editing'
  // 'approved' withdraws too -- it is that status's only
  // non-destructive exit now that the submit status gate refuses a
  // non-editing branch (api/branch-status.ts, api/branch-withdraw.ts).
  // This button is a two-state toggle, so every withdrawable status
  // has to drive the withdraw side of it, not just 'submitted'.
  const isWithdrawable = isSubmitted || branchStatus === 'approved'

  // The protected base branch can never be submitted for review (both
  // modes); hide the button entirely rather than showing it disabled.
  // Withdraw stays available as the recovery path for a base branch
  // wrongly stuck in 'submitted'.
  if (branchIsProtected && !isWithdrawable) return null

  // Who may submit/withdraw: creator, ACL access, the system branch, or an
  // admin/reviewer (alone on a locked-down branch, and even without ACL access
  // on a protected base branch stuck in 'submitted'). Mirrors the server's
  // canPerformWorkflowAction (BranchManager.tsx), which is the actual
  // enforcer; this only decides whether to show the control disabled.
  const userIsCreator = userContext?.userId === branchCreatedBy
  const isSystemBranch = branchCreatedBy === SYSTEM_USER_ID && !branchIsProtected
  const userInACL =
    userContext &&
    branchAccess &&
    (branchAccess.allowedUsers?.includes(userContext.userId) ||
      userContext.groups?.some((g) => branchAccess.allowedGroups?.includes(g)))
  const userIsPrivileged =
    !!userContext && (isAdmin(userContext.groups ?? []) || isReviewer(userContext.groups ?? []))

  const userHasPermission =
    !isLockedOutOfBranch(branchAccess, userContext?.groups) &&
    (userIsCreator || userInACL || isSystemBranch || userIsPrivileged)
  // A status with no available transition (today: 'archived') is a
  // separate condition from lacking permission, and conflating them
  // sent people to an admin to fix a non-permissions problem.
  const statusHasAction = isEditing || isWithdrawable
  const canPerformAction = userHasPermission && statusHasAction
  // Blocked, it stays focusable (`aria-disabled`), so its reason opens on focus.
  // `busy` alone can't hold it: an entry load clears that shared flag mid-run.
  const actionBlocked = !branchName || busy || savingAll || !canPerformAction
  const waitReason = savingAll ? 'Wait for Save all to finish.' : undefined

  return (
    <Tooltip
      label={
        // No branch data (`branchStatus === undefined`) must not be
        // interpolated raw into this label. Guarded explicitly here rather
        // than left to the early return above, which hides this button
        // today only as a side effect of `branchIsProtected`'s `?? true`
        // default -- not a guarantee this arm stays unreachable.
        waitReason ??
        (branchStatus === undefined
          ? 'Branch details could not be loaded. Use "Switch branch…" to retry.'
          : !statusHasAction
            ? `This branch is ${branchStatus}, so it can't be submitted for review or withdrawn from review.`
            : !userHasPermission
              ? 'You do not have permission to submit this branch for review or withdraw it from review. Ask an admin for access.'
              : '')
      }
      disabled={canPerformAction && !waitReason}
      multiline
      maw={320}
    >
      <Button
        size="sm"
        // Save is the top bar's one filled primary; the rest take their colour's light variant.
        variant="light"
        color={isWithdrawable ? 'orange' : undefined}
        style={{ flexShrink: 0 }}
        onClick={() => {
          if (actionBlocked) return
          if (isWithdrawable) onWithdraw()
          else onSubmit()
        }}
        data-disabled={actionBlocked ? true : undefined}
        aria-disabled={actionBlocked ? true : undefined}
        data-testid={isWithdrawable ? 'withdraw-button' : 'submit-button'}
      >
        {isWithdrawable ? EDITOR_ACTIONS.withdrawFromReview : EDITOR_ACTIONS.submitForReview}
      </Button>
    </Tooltip>
  )
}
