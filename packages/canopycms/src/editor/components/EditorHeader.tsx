import React, { type Ref } from 'react'
import { Button, Tooltip } from '@mantine/core'
import type { OperatingMode } from '../../operating-mode'
import type { BranchStatus } from '../../types'
import type { LogicalPath } from '../../paths/types'
import type { SaveAllProgress } from '../hooks/save-all'
import { clientOperatingStrategy } from '../../operating-mode/client'
import { isAdmin, isLockedOutOfBranch, isReviewer } from '../../authorization/helpers'
import { branchBarStatusPresentation } from '../branch-status'
import { EDITOR_ACTIONS } from '../copy'
import { SYSTEM_USER_ID } from '../../system-users'
import { TopBar } from '../shell/TopBar'
import { describeBranchLock } from './BranchLockBanner'
import { BranchPill } from './BranchPill'
import { DraftStorageWarning, SaveAllButton } from './SaveAllButton'

export interface EditorHeaderProps {
  branchName: string
  operatingMode: OperatingMode
  /** Whether operations are currently in progress. */
  busy: boolean
  /** The listed entries with unsaved changes on the branch. */
  editedFiles: Array<{ path: LogicalPath; label: string }>
  /** Entries with unsaved changes on the branch. */
  modifiedCount: number
  /** The branch pill. */
  branchToggleRef?: Ref<HTMLButtonElement>
  onEntrySelect: (path: LogicalPath) => void
  /** Re-reads the branch and its entry list, keeping drafts. */
  onBranchReloadData: () => void
  onBranchDiscardDrafts: () => void
  onBranchManagerOpen: () => void
  onSaveAll: () => void
  saveAllProgress: SaveAllProgress | null
  /** A single Save is in flight, on any entry. */
  singleSaving?: boolean
  /** The branch's entry list failed to load and none is held. */
  entryListFailed?: boolean
  onSubmit: () => void
  onWithdraw: () => void
  /** Writing drafts to localStorage failed, so they live only in this tab. */
  draftStorageFailed?: boolean
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
  /** Whether the current branch is read-only (protected base branch in prod); disables Save all. */
  branchReadOnly?: boolean
  /** Server-computed: content writes are rejected on this branch; see `branchLockState`. */
  branchWriteBlocked?: boolean
  /** No branch details yet: the fail-closed lock defaults are guesses the status doesn't name. */
  branchLoading?: boolean
}

/**
 * The top bar's contents: the branch pill, Submit or Withdraw, the draft-storage warning and
 * Save all. The open entry's own controls are in `EntryHeader`.
 */
export function EditorHeader({
  branchName,
  operatingMode,
  busy,
  editedFiles,
  modifiedCount,
  branchToggleRef,
  onEntrySelect,
  onBranchReloadData,
  onBranchDiscardDrafts,
  onBranchManagerOpen,
  onSaveAll,
  saveAllProgress,
  singleSaving = false,
  entryListFailed = false,
  onSubmit,
  onWithdraw,
  draftStorageFailed = false,
  branchStatus,
  userContext,
  branchCreatedBy,
  branchAccess,
  branchIsProtected = false,
  branchReadOnly = false,
  branchWriteBlocked = false,
  branchLoading = false,
}: EditorHeaderProps) {
  // Set exactly when BranchLockBanner renders.
  const branchLockReason = describeBranchLock({ branchStatus, branchReadOnly, branchWriteBlocked })

  const presentation = branchBarStatusPresentation(branchStatus, branchIsProtected)
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
          <DraftStorageWarning shown={draftStorageFailed && modifiedCount > 0} />
          <SaveAllButton
            // Its reserved width follows this branch's counts, not the session's largest.
            key={branchName}
            onSaveAll={onSaveAll}
            unsavedCount={modifiedCount}
            blockedReason={
              branchLockReason ??
              (!branchName
                ? 'Open a branch first.'
                : entryListFailed && modifiedCount > 0
                  ? 'The list of entries couldn\'t be loaded, so these changes can\'t be saved yet. Choose "Refresh branch" in the branch menu to try again.'
                  : undefined)
            }
            saveAllProgress={saveAllProgress}
            singleSaving={singleSaving}
            busy={busy}
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
        // The entry's Save is the one filled primary; the rest take their colour's light variant.
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
