import React, { useRef, type ReactNode, type Ref } from 'react'
import {
  Box,
  Button,
  Group,
  Menu,
  Text,
  Tooltip,
  VisuallyHidden,
  em,
  getBreakpointValue,
  useMantineTheme,
} from '@mantine/core'
import { useMediaQuery, useMergedRef } from '@mantine/hooks'
import { IconChevronDown, IconLock } from '@tabler/icons-react'
import type { BranchStatus, PullRequestState } from '../../types'
import type { SaveAllProgress } from '../hooks/save-all'
import { isAdmin, isLockedOutOfBranch, isReviewer } from '../../authorization/helpers'
import { branchBarStatus, describeBranchLock, type BranchBarStatus } from '../branch-lock'
import { EDITOR_ACTIONS } from '../copy'
import { reviewRoleOf, type ReviewRole } from '../../authorization/review-role'
import { SYSTEM_USER_ID } from '../../system-users'
import { TopBar } from '../shell/TopBar'
import { BranchPill } from './BranchPill'
import { ReasonedMenuItem } from './ReasonedMenuItem'
import { UnsavedMark } from './UnsavedMark'
import { DraftStorageWarning, HIDDEN_STYLE, SaveAllButton } from './SaveAllButton'
import { useFocusHandOff, useMenuItemFocusReturn } from '../utils/focus-return'

export interface EditorHeaderProps {
  branchName: string
  /** Whether operations are currently in progress. */
  busy: boolean
  /** Entries with unsaved changes on the branch. */
  modifiedCount: number
  /** Lists the unsaved entries: the content panel, filtered to Changed. */
  onShowUnsaved: () => void
  /** The branch pill. */
  branchToggleRef?: Ref<HTMLButtonElement>
  /** Re-reads the branch and its entry list, keeping drafts. */
  onBranchReloadData: () => void
  onBranchDiscardDrafts: () => void
  onBranchManagerOpen: () => void
  /** Opens Branches with its new-branch form; Branches alone without it. */
  onNewBranch?: () => void
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
  /** Opens the approve dialog, which returns focus to `returnFocusTo()` when given. */
  onApprove?: (returnFocusTo?: () => HTMLElement | null) => void
  /** Opens the request-changes dialog, which returns focus to `returnFocusTo()` when given. */
  onRequestChanges?: (returnFocusTo?: () => HTMLElement | null) => void
  /** Writing drafts to localStorage failed, so they live only in this tab. */
  draftStorageFailed?: boolean
  /** Current branch status (undefined if unknown). */
  branchStatus: BranchStatus | undefined
  /** Current user context for permission checks. */
  userContext?: { userId: string; groups?: string[] }
  branchCreatedBy?: string
  /** The PR's state as last observed; a closed one blocks Approve and Request changes. */
  branchPullRequestState?: PullRequestState
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
  /** `currentBranch.isProtected` for the status, unlike `branchIsProtected` not failed closed here. */
  branchServerProtected?: boolean
  /** Whether the current branch is read-only (protected base branch in prod); disables Save all. */
  branchReadOnly?: boolean
  /** Server-computed: content writes are rejected on this branch; see `branchLockState`. */
  branchWriteBlocked?: boolean
  /** No branch details yet: the fail-closed lock defaults are guesses the status doesn't name. */
  branchLoading?: boolean
  /** The branch list is still being fetched, as opposed to having failed or lacking this branch. */
  branchPending?: boolean
  /** The branch list answered without this branch. */
  branchMissing?: boolean
}

/**
 * The branch bar: the pill, the branch's status and its unsaved count, then the draft-storage
 * warning, Save all, the way forward and Submit or Withdraw, or to a reviewer of someone else's
 * submission Approve and Request changes. The open entry's own controls are in `EntryHeader`.
 */
export function EditorHeader({
  branchName,
  busy,
  modifiedCount,
  onShowUnsaved,
  branchToggleRef,
  onBranchReloadData,
  onBranchDiscardDrafts,
  onBranchManagerOpen,
  onNewBranch = onBranchManagerOpen,
  onSaveAll,
  saveAllProgress,
  singleSaving = false,
  entryListFailed = false,
  onSubmit,
  onWithdraw,
  onApprove = noopAction,
  onRequestChanges = noopAction,
  draftStorageFailed = false,
  branchStatus,
  userContext,
  branchCreatedBy,
  branchPullRequestState,
  branchAccess,
  branchIsProtected = false,
  branchServerProtected,
  branchReadOnly = false,
  branchWriteBlocked = false,
  branchLoading = false,
  branchPending = false,
  branchMissing = false,
}: EditorHeaderProps) {
  const reviewRole = reviewRoleOf(
    {
      status: branchStatus,
      createdBy: branchCreatedBy,
      users: branchAccess?.allowedUsers,
      groups: branchAccess?.allowedGroups,
      isProtected: branchIsProtected,
      pullRequestState: branchPullRequestState,
    },
    userContext,
  )
  const workflow = workflowAction({
    branchName,
    busy,
    branchStatus,
    userContext,
    branchCreatedBy,
    branchAccess,
    branchIsProtected,
    reviewRole,
    savingAll: !!saveAllProgress,
  })
  const lock = {
    branchStatus,
    branchReadOnly,
    branchWriteBlocked,
    branchPending,
    branchMissing,
    reviewing: workflow?.kind === 'review',
    pullRequestClosed: reviewRole === 'reviewing-closed',
  }
  const branchLockReason = describeBranchLock(lock)
  const status = branchBarStatus({ ...lock, isProtected: branchServerProtected })

  const theme = useMantineTheme()
  // Mantine's own below-`md` query, the one `visibleFrom="md"` hides under.
  const belowMd = `(max-width: ${em(getBreakpointValue('md', theme.breakpoints) - 0.1)})`
  const narrow = useMediaQuery(belowMd, false, { getInitialValueInEffect: false }) === true
  const editable = !!branchName && !branchLoading && !branchLockReason
  // Below `md` one split button holds the bar's actions: Save all on an editable branch, else the
  // row's way forward, with the workflow action in its caret. Withdraw leads only for a user who
  // may withdraw; anyone else gets Switch branch…, the blocked Withdraw and its reason in the
  // caret. A reviewer's Approve leads the same way, with Request changes in its own caret. A
  // protected branch keeps New branch… either way. Wide, a Withdraw the user can't take shows
  // blocked, with no Switch branch… beside it: that stays in the pill's menu.
  const split = narrow && editable
  const workflowLeads = status.action === 'workflow' && !!workflow?.permitted
  const barAction =
    status.action === 'workflow'
      ? narrow && !workflowLeads
        ? 'switchBranch'
        : undefined
      : status.action

  // Controls come and go as a submit or withdraw changes the lock, and focus follows them.
  const [[wayRef, saveAllRef, workflowRef, secondaryRef], focusTarget] = useFocusHandOff(4)
  const workflowControl = {
    onSubmit,
    onWithdraw,
    onApprove,
    onRequestChanges,
    controlRef: workflowRef,
    secondaryRef,
    // A withdraw that leaves no workflow action returns focus to the way forward, else Save all.
    returnFocusTo: () => focusTarget(2),
  }

  const caretOnWay = narrow && !!barAction && !!workflow

  return (
    <TopBar
      leading={
        <Group gap="xs" wrap="wrap" align="center" style={{ rowGap: 4 }}>
          <BranchPill
            branchName={branchName}
            loading={busy}
            unsavedCount={modifiedCount}
            onSwitchBranch={onBranchManagerOpen}
            onRefreshBranch={onBranchReloadData}
            onDiscardAll={onBranchDiscardDrafts}
            pillRef={branchToggleRef}
          />
          <BranchStatusLabel
            status={branchName ? status : { value: 'none', readOnly: false }}
            reason={branchLockReason}
          />
          {modifiedCount > 0 && (
            <Tooltip
              label={unsavedTooltip(
                branchName ? status : undefined,
                modifiedCount,
                workflow?.kind === 'withdraw' && workflow.permitted,
              )}
              events={TOOLTIP_EVENTS}
              multiline
              maw={320}
            >
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                style={{ flexShrink: 0 }}
                leftSection={<UnsavedMark aria-hidden="true" />}
                onClick={onShowUnsaved}
                data-testid="branch-unsaved-count"
              >
                {`${modifiedCount} unsaved`}
              </Button>
            </Tooltip>
          )}
        </Group>
      }
      trailing={
        <>
          <DraftStorageWarning shown={draftStorageFailed && modifiedCount > 0} />
          {/* A lock can end, so wide Save all stays and says why; below `md` space wins. */}
          {(!narrow || editable) && (
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
              buttonRef={saveAllRef}
              caret={
                split && workflow ? (
                  <WorkflowCaret {...workflowControl} action={workflow} />
                ) : undefined
              }
            />
          )}
          {barAction && (
            <BranchWayButton
              action={barAction}
              buttonRef={wayRef}
              onClick={
                barAction === 'newBranch'
                  ? onNewBranch
                  : barAction === 'refreshBranch'
                    ? onBranchReloadData
                    : onBranchManagerOpen
              }
              caret={
                caretOnWay && workflow ? (
                  <WorkflowCaret {...workflowControl} action={workflow} />
                ) : undefined
              }
            />
          )}
          {!split && !caretOnWay && workflow && (
            <WorkflowButton {...workflowControl} action={workflow} narrow={narrow} />
          )}
        </>
      }
    />
  )
}

const noopAction = () => {}

/** Why a workflow control waits when the bar is busy and nothing else holds it. */
const BUSY_REASON = 'Wait for the current save or load to finish.'

const TOOLTIP_EVENTS = { hover: true, focus: true, touch: false }

/**
 * On a locked branch, what would let its drafts be saved. A new branch starts without them, so a
 * branch never editable again leaves only discarding, as `ReadOnlyDraftNotice` says.
 */
function unsavedTooltip(
  status: BranchBarStatus | undefined,
  count: number,
  mayWithdraw: boolean,
): string {
  if (!status?.readOnly) return 'Show unsaved entries in the content panel'
  const edits = `${count} unsaved ${count === 1 ? 'edit' : 'edits'} in this browser.`
  if (status.action === 'workflow' && mayWithdraw) return `${edits} Withdraw to save them.`
  if (status.value === 'unavailable') return `${edits} Use "Refresh branch" to load its details.`
  if (status.value === 'not-available')
    return `${edits} They can't be saved unless this branch is available to you.`
  if (status.value === 'protected' || status.value === 'archived')
    return `${edits} This branch won't become editable, so they can only be discarded.`
  return `${edits} They can be saved once the branch is editable again.`
}

/** The branch's state beside the pill, heard in words with its reason, but not while it loads. */
function BranchStatusLabel({ status, reason }: { status: BranchBarStatus; reason?: string }) {
  const spoken =
    status.label && status.value !== 'loading'
      ? [status.label.replace(' · ', ', '), reason].filter(Boolean).join('. ')
      : ''
  return (
    // Always mounted, so a lock that arrives is announced.
    <Box role="status" style={status.label ? { flexShrink: 0 } : HIDDEN_STYLE}>
      {status.label && (
        <Group
          gap={4}
          wrap="nowrap"
          aria-hidden="true"
          data-testid="branch-status"
          data-status={status.value}
        >
          {status.readOnly && <IconLock size={14} />}
          <Text span size="sm">
            {status.label}
          </Text>
        </Group>
      )}
      <VisuallyHidden>{spoken}</VisuallyHidden>
    </Box>
  )
}

const WAY_LABEL = {
  newBranch: `${EDITOR_ACTIONS.newBranch}…`,
  switchBranch: `${EDITOR_ACTIONS.switchBranch}…`,
  refreshBranch: 'Refresh branch',
} as const

/** The way forward from a locked branch: New branch…, Switch branch… or Refresh branch. */
function BranchWayButton({
  action,
  onClick,
  caret,
  buttonRef,
}: {
  action: keyof typeof WAY_LABEL
  onClick: () => void
  buttonRef: Ref<HTMLButtonElement>
  /** The workflow action's caret below `md`, making it a split button. */
  caret?: ReactNode
}) {
  return (
    // Grouped even alone, as Save all is, so a caret coming or going never remounts the button.
    <Button.Group
      style={{ flexShrink: 0 }}
      renderRoot={(props) => (
        <div
          {...props}
          role={caret ? 'group' : undefined}
          aria-label={caret ? 'Branch controls' : undefined}
        />
      )}
    >
      <Button
        ref={buttonRef}
        variant="light"
        size="sm"
        onClick={() => onClick()}
        data-testid={`${action.replace('Branch', '')}-branch-button`}
      >
        {WAY_LABEL[action]}
      </Button>
      {caret}
    </Button.Group>
  )
}

/** The branch's review action, as both the wide button and the narrow caret offer it. */
interface WorkflowAction {
  /** 'review' is Approve and Request changes, for a reviewer of someone else's submission. */
  kind: 'submit' | 'withdraw' | 'review'
  /** Kind 'review': Approve is offered, because the branch is submitted rather than approved. */
  offersApprove?: boolean
  /** It can't act now. */
  blocked: boolean
  /** The user may take it and the status allows it, whatever else holds it now. */
  permitted: boolean
  /** Why it can't; empty when it can, or when only a load, a save or a missing branch holds it. */
  reason: string
}

type WorkflowActionInput = Pick<
  EditorHeaderProps,
  'branchName' | 'busy' | 'branchStatus' | 'userContext' | 'branchCreatedBy' | 'branchAccess'
> & {
  branchIsProtected: boolean
  reviewRole: ReviewRole
  savingAll: boolean
}

/**
 * Submit for review, or Withdraw from review once submitted or approved, or Approve and Request
 * changes to a reviewer of someone else's submission; null when none shows.
 */
function workflowAction({
  branchName,
  busy,
  branchStatus,
  userContext,
  branchCreatedBy,
  branchAccess,
  branchIsProtected,
  reviewRole,
  savingAll,
}: WorkflowActionInput): WorkflowAction | null {
  const isSubmitted = branchStatus === 'submitted'
  const isEditing = branchStatus === 'editing'
  // 'approved' withdraws too -- it is the author's way back from
  // either status, since the editor offers an author no Request changes
  // and the submit gate refuses a non-editing branch (api/branch-withdraw.ts).
  // This button is a two-state toggle, so every withdrawable status
  // has to drive the withdraw side of it, not just 'submitted'.
  const isWithdrawable = isSubmitted || branchStatus === 'approved'

  // The protected base branch can never be submitted for review (both
  // modes); hide the button entirely rather than showing it disabled.
  // Withdraw stays available as the recovery path for a base branch
  // wrongly stuck in 'submitted'.
  if (branchIsProtected && !isWithdrawable) return null

  if (reviewRole === 'reviewing') {
    return {
      kind: 'review',
      offersApprove: isSubmitted,
      blocked: !branchName || busy || savingAll,
      permitted: true,
      reason: savingAll ? 'Wait for Save all to finish.' : busy ? BUSY_REASON : '',
    }
  }

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
    permitted: canPerformAction,
    reason: savingAll
      ? 'Wait for Save all to finish.'
      : // No branch data (`branchStatus === undefined`) must not be
        // interpolated raw into this label. Guarded explicitly here rather
        // than left to the early return above, which hides the action
        // today only as a side effect of `branchIsProtected`'s `?? true`
        // default -- not a guarantee this arm stays unreachable.
        branchStatus === undefined
        ? 'Branch details could not be loaded. Use "Refresh branch" to try again.'
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
  onApprove: NonNullable<EditorHeaderProps['onApprove']>
  onRequestChanges: NonNullable<EditorHeaderProps['onRequestChanges']>
  /** The control's own button: the wide button, or the caret. */
  controlRef: Ref<HTMLButtonElement>
  /** A review's second control, Request changes beside Approve or the caret that holds it. */
  secondaryRef?: Ref<HTMLButtonElement>
  /** Where the confirm dialog returns focus: whichever control is mounted as it closes. */
  returnFocusTo: () => HTMLElement | null
}

function WorkflowButton({
  narrow,
  ...props
}: WorkflowControlProps & {
  /** Below `md`, where Request changes goes under a caret beside Approve. */
  narrow: boolean
}) {
  return props.action.kind === 'review' ? (
    <ReviewButtons {...props} narrow={narrow} />
  ) : (
    <SubmitOrWithdrawButton {...props} />
  )
}

/**
 * Approve (leading) and Request changes. Below `md`, Approve is a split button whose caret holds
 * Request changes; with nothing to approve, Request changes stands alone.
 */
function ReviewButtons({
  action,
  onApprove,
  onRequestChanges,
  controlRef,
  secondaryRef,
  returnFocusTo,
  narrow,
  ...rest
}: WorkflowControlProps & { narrow: boolean }) {
  // The bar's hand-off slot goes to Approve while there is one, in either layout, so focus on it
  // moves on when it goes; then Request changes, the one control left, takes the slot. Beside
  // Approve, Request changes (or the caret that holds it) has a slot of its own, so focus on it
  // moves on when the branch leaves review.
  const approveEl = useRef<HTMLButtonElement>(null)
  const requestChangesEl = useRef<HTMLButtonElement>(null)
  const approveRef = useMergedRef(approveEl, action.offersApprove ? controlRef : undefined)
  const requestChangesRef = useMergedRef(
    requestChangesEl,
    action.offersApprove ? (narrow ? undefined : secondaryRef) : controlRef,
  )
  // Each returns focus to its own button while that is mounted, else to the control left.
  const approveReturn = () => (approveEl.current?.isConnected ? approveEl.current : returnFocusTo())
  const requestChangesReturn = () =>
    requestChangesEl.current?.isConnected ? requestChangesEl.current : returnFocusTo()
  const approve = (
    <ReviewButton
      buttonRef={approveRef}
      action={action}
      color="brand"
      testId="approve-button"
      label={EDITOR_ACTIONS.approve}
      onClick={() => onApprove(approveReturn)}
    />
  )
  const requestChanges = (
    <ReviewButton
      buttonRef={requestChangesRef}
      action={action}
      color="orange"
      testId="request-changes-button"
      label={EDITOR_ACTIONS.requestChanges}
      onClick={() => onRequestChanges(requestChangesReturn)}
    />
  )
  if (!action.offersApprove) return requestChanges
  if (!narrow) {
    return (
      <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
        {requestChanges}
        {approve}
      </Group>
    )
  }
  return (
    <Button.Group
      style={{ flexShrink: 0 }}
      renderRoot={(props) => <div {...props} role="group" aria-label="Review controls" />}
    >
      {approve}
      <WorkflowCaret
        {...rest}
        action={action}
        onApprove={onApprove}
        onRequestChanges={onRequestChanges}
        returnFocusTo={returnFocusTo}
        includeApprove={false}
        color="brand"
        controlRef={secondaryRef}
      />
    </Button.Group>
  )
}

/** One review button, blocked as a whole with the action's reason. */
function ReviewButton({
  action,
  buttonRef,
  color,
  testId,
  label,
  onClick,
}: {
  action: WorkflowAction
  buttonRef?: Ref<HTMLButtonElement>
  color: string
  testId: string
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip label={action.reason} disabled={!action.reason} multiline maw={320}>
      <Button
        ref={buttonRef}
        size="sm"
        variant="light"
        color={color}
        style={{ flexShrink: 0 }}
        onClick={() => {
          if (!action.blocked) onClick()
        }}
        // Blocked, it stays focusable (`aria-disabled`), so its reason opens on focus.
        data-disabled={action.blocked ? true : undefined}
        aria-disabled={action.blocked ? true : undefined}
        data-testid={testId}
      >
        {label}
      </Button>
    </Tooltip>
  )
}

function SubmitOrWithdrawButton({
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

/**
 * The workflow action's caret below `md`, on Save all or the way forward or, for a review, beside
 * Approve. `includeApprove` is false there, where Approve is already a button.
 */
function WorkflowCaret({
  action,
  onSubmit,
  onWithdraw,
  onApprove,
  onRequestChanges,
  controlRef,
  returnFocusTo,
  includeApprove = true,
  color,
}: Omit<WorkflowControlProps, 'controlRef'> & {
  controlRef?: Ref<HTMLButtonElement>
  includeApprove?: boolean
  /** Matches the button it sits beside. */
  color?: string
}) {
  const caret = useRef<HTMLButtonElement>(null)
  const caretRef = useMergedRef(caret, controlRef)
  const menuFocus = useMenuItemFocusReturn(caret)
  const withdraw = action.kind === 'withdraw'
  // Beside Approve it holds only Request changes, and a dialog it opens returns to the caret.
  const reviewCaret = action.kind === 'review' && !includeApprove
  const caretLabel = reviewCaret ? 'More review actions' : 'Branch actions'
  const returnToCaret = reviewCaret
    ? () => (caret.current?.isConnected ? caret.current : returnFocusTo())
    : returnFocusTo
  const blockedReason = action.blocked ? action.reason || BUSY_REASON : undefined
  return (
    // Bounded, so a blocked item's reason wraps on a phone rather than run off the screen.
    <Menu withinPortal shadow="sm" position="bottom-end" width={280} {...menuFocus.menu}>
      <Tooltip label={caretLabel} events={{ hover: true, focus: true, touch: false }}>
        <Menu.Target>
          <Button
            ref={caretRef}
            variant="light"
            color={color}
            size="sm"
            px={8}
            aria-label={caretLabel}
            data-testid="branch-actions-button"
            style={{ borderInlineStart: '1px solid var(--canopy-input-border)' }}
          >
            <IconChevronDown size={14} aria-hidden="true" />
          </Button>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown {...menuFocus.dropdown}>
        {action.kind === 'review' ? (
          <>
            {action.offersApprove && includeApprove && (
              <ReasonedMenuItem
                data-testid="approve-menu-item"
                blockedReason={blockedReason}
                onClick={() => onApprove(returnToCaret)}
              >
                {EDITOR_ACTIONS.approve}
              </ReasonedMenuItem>
            )}
            <ReasonedMenuItem
              data-testid="request-changes-menu-item"
              blockedReason={blockedReason}
              onClick={() => onRequestChanges(returnToCaret)}
            >
              {EDITOR_ACTIONS.requestChanges}
            </ReasonedMenuItem>
          </>
        ) : (
          <ReasonedMenuItem
            data-testid={withdraw ? 'withdraw-menu-item' : 'submit-menu-item'}
            blockedReason={blockedReason}
            onClick={() => {
              if (withdraw) onWithdraw(returnFocusTo)
              else onSubmit(returnFocusTo)
            }}
          >
            {withdraw ? EDITOR_ACTIONS.withdrawFromReview : EDITOR_ACTIONS.submitForReview}
          </ReasonedMenuItem>
        )}
      </Menu.Dropdown>
    </Menu>
  )
}
