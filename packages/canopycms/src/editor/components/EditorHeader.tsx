import React, { useCallback, useLayoutEffect, useRef, type Ref } from 'react'
import { Button, Menu, Tooltip, em, getBreakpointValue, useMantineTheme } from '@mantine/core'
import { useMediaQuery, useMergedRef } from '@mantine/hooks'
import { IconChevronDown } from '@tabler/icons-react'
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
import { ReasonedMenuItem } from './ReasonedMenuItem'
import { DraftStorageWarning, SaveAllButton } from './SaveAllButton'
import { ENTRY_HEADER_HEIGHT } from './EntryHeader'
import { useMenuItemFocusReturn } from '../utils/focus-return'

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
  /** Opens the submit dialog, which returns focus to `returnFocusTo()` when given. */
  onSubmit: (returnFocusTo?: () => HTMLElement | null) => void
  /** Opens the withdraw dialog, which returns focus to `returnFocusTo()` when given. */
  onWithdraw: (returnFocusTo?: () => HTMLElement | null) => void
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
   * authorization/protected-branch.ts). Hides Submit, as a button or in the caret
   * (Withdraw stays, as the recovery path). Default false.
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
 * The branch bar's contents: the branch pill at its start; the draft-storage warning, Save all and
 * Submit or Withdraw at its end. The open entry's own controls are in `EntryHeader`.
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

  // Below `md` on an editable branch, the workflow action joins Save all as its caret.
  const theme = useMantineTheme()
  // Mantine's own below-`md` query, the one `visibleFrom="md"` hides under.
  const belowMd = `(max-width: ${em(getBreakpointValue('md', theme.breakpoints) - 0.1)})`
  const narrow = useMediaQuery(belowMd, false, { getInitialValueInEffect: false }) === true
  const editable = !!branchName && !branchLoading && !branchLockReason
  const workflow = workflowAction({
    branchName,
    busy,
    branchStatus,
    userContext,
    branchCreatedBy,
    branchAccess,
    branchIsProtected,
    savingAll: !!saveAllProgress,
  })
  const split = narrow && editable

  // The workflow control is the caret or a button by turns, as a submit locks the branch or a
  // withdraw unlocks it; focus on the outgoing one moves to the incoming one, not to the page.
  const workflowEl = useRef<HTMLButtonElement | null>(null)
  const handOffFocus = useRef(false)
  // Focused on attach, so a detach and re-attach of the same button (React's dev StrictMode)
  // cancel out; a commit that mounts no control clears the hand-off in the layout effect.
  const workflowRef = useCallback((el: HTMLButtonElement | null) => {
    if (el) {
      if (handOffFocus.current) {
        handOffFocus.current = false
        el.focus({ preventScroll: true })
      }
    } else if (workflowEl.current && workflowEl.current === document.activeElement) {
      handOffFocus.current = true
    }
    workflowEl.current = el
  }, [])
  useLayoutEffect(() => {
    handOffFocus.current = false
  })
  const workflowControl = {
    onSubmit,
    onWithdraw,
    controlRef: workflowRef,
    returnFocusTo: () => workflowEl.current,
  }

  return (
    <TopBar
      leading={
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
      }
      trailing={
        <>
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
            caret={
              split && workflow ? (
                <WorkflowCaret {...workflowControl} action={workflow} />
              ) : undefined
            }
          />
          {!split && workflow && <WorkflowButton {...workflowControl} action={workflow} />}
        </>
      }
    />
  )
}

/** The branch's review action, as both the wide button and the narrow caret offer it. */
interface WorkflowAction {
  kind: 'submit' | 'withdraw'
  /** It can't act now. */
  blocked: boolean
  /** Why it can't; empty when it can, or when only a load, a save or a missing branch holds it. */
  reason: string
}

type WorkflowActionInput = Pick<
  EditorHeaderProps,
  'branchName' | 'busy' | 'branchStatus' | 'userContext' | 'branchCreatedBy' | 'branchAccess'
> & { branchIsProtected: boolean; savingAll: boolean }

/** Submit for review, or Withdraw from review once submitted or approved; null when neither shows. */
function workflowAction({
  branchName,
  busy,
  branchStatus,
  userContext,
  branchCreatedBy,
  branchAccess,
  branchIsProtected,
  savingAll,
}: WorkflowActionInput): WorkflowAction | null {
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

  return {
    kind: isWithdrawable ? 'withdraw' : 'submit',
    // `busy` alone can't hold it: an entry load clears that shared flag mid-run.
    blocked: !branchName || busy || savingAll || !canPerformAction,
    reason: savingAll
      ? 'Wait for Save all to finish.'
      : // No branch data (`branchStatus === undefined`) must not be
        // interpolated raw into this label. Guarded explicitly here rather
        // than left to the early return above, which hides the action
        // today only as a side effect of `branchIsProtected`'s `?? true`
        // default -- not a guarantee this arm stays unreachable.
        branchStatus === undefined
        ? 'Branch details could not be loaded. Use "Switch branch…" to retry.'
        : !statusHasAction
          ? `This branch is ${branchStatus}, so it can't be submitted for review or withdrawn from review.`
          : !userHasPermission
            ? 'You do not have permission to submit this branch for review or withdraw it from review. Ask an admin for access.'
            : '',
  }
}

interface WorkflowControlProps {
  action: WorkflowAction
  onSubmit: EditorHeaderProps['onSubmit']
  onWithdraw: EditorHeaderProps['onWithdraw']
  /** The control's own button: the wide button, or the caret. */
  controlRef: (el: HTMLButtonElement | null) => void
  /** Where the confirm dialog returns focus: whichever control is mounted as it closes. */
  returnFocusTo: () => HTMLElement | null
}

function WorkflowButton({
  action,
  onSubmit,
  onWithdraw,
  controlRef,
  returnFocusTo,
}: WorkflowControlProps) {
  const withdraw = action.kind === 'withdraw'
  return (
    <Tooltip label={action.reason} disabled={!action.reason} multiline maw={320}>
      <Button
        ref={controlRef}
        size="sm"
        // The entry's Save is the one filled primary; the rest take their colour's light variant.
        variant="light"
        color={withdraw ? 'orange' : undefined}
        style={{ flexShrink: 0 }}
        onClick={() => {
          if (action.blocked) return
          if (withdraw) onWithdraw(returnFocusTo)
          else onSubmit(returnFocusTo)
        }}
        // Blocked, it stays focusable (`aria-disabled`), so its reason opens on focus.
        data-disabled={action.blocked ? true : undefined}
        aria-disabled={action.blocked ? true : undefined}
        data-testid={withdraw ? 'withdraw-button' : 'submit-button'}
      >
        {withdraw ? EDITOR_ACTIONS.withdrawFromReview : EDITOR_ACTIONS.submitForReview}
      </Button>
    </Tooltip>
  )
}

/** Save all's caret below `md`, holding the workflow action. */
function WorkflowCaret({
  action,
  onSubmit,
  onWithdraw,
  controlRef,
  returnFocusTo,
}: WorkflowControlProps) {
  const caret = useRef<HTMLButtonElement>(null)
  const caretRef = useMergedRef(caret, controlRef)
  const menuFocus = useMenuItemFocusReturn(caret)
  const withdraw = action.kind === 'withdraw'
  return (
    // Bounded, so a blocked item's reason wraps on a phone rather than run off the screen.
    <Menu withinPortal shadow="sm" position="bottom-end" width={280} {...menuFocus.menu}>
      <Tooltip
        label="Branch actions"
        events={{ hover: true, focus: true, touch: false }}
        position="bottom-end"
        offset={ENTRY_HEADER_HEIGHT + 8}
      >
        <Menu.Target>
          <Button
            ref={caretRef}
            variant="light"
            size="sm"
            px={8}
            aria-label="Branch actions"
            data-testid="branch-actions-button"
            style={{ borderInlineStart: '1px solid var(--canopy-input-border)' }}
          >
            <IconChevronDown size={14} aria-hidden="true" />
          </Button>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown {...menuFocus.dropdown}>
        <ReasonedMenuItem
          data-testid={withdraw ? 'withdraw-menu-item' : 'submit-menu-item'}
          blockedReason={
            action.blocked
              ? action.reason || 'Wait for the current save or load to finish.'
              : undefined
          }
          onClick={() => {
            if (withdraw) onWithdraw(returnFocusTo)
            else onSubmit(returnFocusTo)
          }}
        >
          {withdraw ? EDITOR_ACTIONS.withdrawFromReview : EDITOR_ACTIONS.submitForReview}
        </ReasonedMenuItem>
      </Menu.Dropdown>
    </Menu>
  )
}
