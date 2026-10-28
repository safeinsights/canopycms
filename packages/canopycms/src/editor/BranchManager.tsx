'use client'

import React, { useRef, useState } from 'react'

import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Textarea,
  Collapse,
  Tooltip,
} from '@mantine/core'
import { IconDots, IconExternalLink } from '@tabler/icons-react'
import type { OperatingMode } from '../operating-mode'
import type { ConflictStatus, PullRequestState, SyncStatus } from '../types'
import type { CommentThread } from '../comment-store'
import type { UserSearchResult } from '../auth/types'
import { BranchComments } from './comments/BranchComments'
import { UserBadge } from './components/UserBadge'
import { BranchAccessList } from './components/BranchAccessList'
// Import directly from helpers to avoid server-only code in authorization barrel
import { isAdmin, isLockedOutOfBranch, isReviewer } from '../authorization/helpers'
import { clientOperatingStrategy } from '../operating-mode/client'
import { DestructiveMenuItem } from './components/DestructiveMenuItem'
import { ReasonedMenuItem } from './components/ReasonedMenuItem'
import { RelativeTime } from './components/RelativeTime'
import { branchStatusPresentation } from './branch-status'
import { CLOSED_PULL_REQUEST_REASON, EDITOR_ACTIONS } from './copy'
import { isReviewerOfOthersReview } from '../authorization/review-role'
import { SYSTEM_USER_ID } from '../system-users'

/** @internal Exported for tests. */
export interface BranchSummary {
  name: string
  status: string
  createdBy?: string
  updatedAt?: string
  access?: {
    users?: string[]
    groups?: string[]
    managerOrAdminAllowed?: boolean
    /** Entries the server withheld from this viewer; see `BranchListItem.withheldAccess`. */
    withheldUsers?: number
    withheldGroups?: number
  }
  pullRequestUrl?: string
  pullRequestNumber?: number
  pullRequestState?: PullRequestState
  mergedAt?: string
  /** Sync status for async GitHub operations (used when Lambda has no internet) */
  syncStatus?: SyncStatus
  /** Short, sanitized reason the last GitHub sync task failed (set alongside syncStatus: 'sync-failed') */
  syncFailureReason?: string
  /** Whether this branch has unresolved merge conflicts with the base branch */
  conflictStatus?: ConflictStatus
  /** ContentIds of entries where --theirs was applied during rebase; cleared on clean rebase */
  conflictFiles?: string[]
  commentCount?: number
  isProtected?: boolean
  readOnly?: boolean
  /**
   * Server-computed compound submit rule (base-branch OR non-'editing'
   * status) -- see `useBranchManager.tsx`'s `BranchSummary.submitBlocked` and
   * `BranchWriteProtection.submitBlockedIncludingStatus` for the full
   * rationale. `getBranchPermissions`'s `canSubmit` consumes this directly
   * instead of re-deriving `status === 'editing' && !isProtected`.
   */
  submitBlocked?: boolean
}

export interface UserContext {
  userId: string
  groups?: string[]
}

/**
 * What the current user can do to a branch, by the backend's hybrid model. Workflow access
 * (`hasWorkflowAccess`) goes to the creator, the users and groups on the branch's access list,
 * anyone on a system branch other than the protected base, and reviewers and admins; a
 * `managerOrAdminAllowed` lockdown leaves only reviewers and admins. Submit also
 * needs the server's `submitBlocked` to be false; Withdraw needs the branch submitted or approved.
 * @internal Exported for tests.
 */
export const getBranchPermissions = (
  branch: BranchSummary,
  user: UserContext | undefined,
): {
  /** Creator, someone given access, a system branch, a reviewer or an admin: who may submit or withdraw. */
  hasWorkflowAccess: boolean
  canSubmit: boolean
  canWithdraw: boolean
  canDelete: boolean
  /** Approve is open to this user now: a reviewer other than the creator, on a submitted branch with a live PR. */
  canApprove: boolean
  canRequestChanges: boolean
} => {
  if (!user) {
    return {
      hasWorkflowAccess: false,
      canSubmit: false,
      canWithdraw: false,
      canDelete: false,
      canApprove: false,
      canRequestChanges: false,
    }
  }

  const userIsAdmin = isAdmin(user.groups)
  const userIsReviewer = isReviewer(user.groups)
  const userIsCreator = branch.createdBy === user.userId
  // The system-branch grant is disabled on the protected base branch -- its
  // auto-provision marker (createdBy: SYSTEM_USER_ID) would otherwise let
  // anyone with general access submit/withdraw/delete it.
  const isSystemBranch = branch.createdBy === SYSTEM_USER_ID && !branch.isProtected

  const userInACL =
    (branch.access?.users?.includes(user.userId) ||
      user.groups?.some((g) => branch.access?.groups?.includes(g))) ??
    false

  const canPerformWorkflowActions =
    !isLockedOutOfBranch(branch.access, user.groups) &&
    (userIsCreator || userInACL || isSystemBranch || userIsAdmin || userIsReviewer)

  // Submit: can perform workflow actions AND the server says submit isn't
  // blocked. `submitBlocked` is the server's own compound answer -- status
  // past 'editing' OR the protected base branch -- computed once in
  // `getBranchWriteProtection` (protected-branch.ts) and threaded through
  // unchanged.
  //
  // `?? true`, not a bare `!branch.submitBlocked`: the field is optional (like
  // `isProtected`/`readOnly` beside it), so a missing value must mean BLOCKED,
  // not allowed -- matching the `?? true` default `useBranchManager.tsx`
  // already applies to the same flag. A `?? false` default here would
  // fail-open for anything constructing a BranchSummary directly.
  const canSubmit = canPerformWorkflowActions && !(branch.submitBlocked ?? true)

  // Withdraw: can perform workflow actions AND branch is submitted or
  // approved -- 'approved' is included because withdraw is that status's only
  // non-destructive exit, and getBranchPermissions must grant canWithdraw for
  // it to be reachable. Allowed even when the PR was closed without merging:
  // that's the deliberate recovery path for a closed-unmerged PR (server-side
  // skip in api/branch-withdraw.ts). Not additionally gated on
  // !branch.isProtected either: withdraw is also how a creator/ACL/privileged
  // user recovers a protected branch wrongly stuck in 'submitted'.
  const canWithdraw =
    canPerformWorkflowActions && (branch.status === 'submitted' || branch.status === 'approved')

  // Delete: Admin or creator (but not if submitted or approved -- both mean
  // an open PR, the latter already reviewed and awaiting merge -- and never
  // the base branch, since deleting the prod serving clone is never valid)
  const canDelete =
    (userIsAdmin || userIsCreator) &&
    branch.status !== 'submitted' &&
    branch.status !== 'approved' &&
    !branch.isProtected

  // Approve and Request changes: a Reviewer or Admin other than the creator, who for an author
  // would only do what Withdraw does. Neither applies to the protected base branch, whose way
  // out of review is Withdraw. A closed PR refuses both (Request changes converts the PR to
  // a draft); Approve also needs the branch submitted, Request changes accepts approved too.
  const reviewsOthers = (userIsAdmin || userIsReviewer) && !userIsCreator && !branch.isProtected
  const prLive = branch.pullRequestState !== 'closed'
  const canApprove = reviewsOthers && branch.status === 'submitted' && prLive
  const canRequestChanges =
    reviewsOthers && (branch.status === 'submitted' || branch.status === 'approved') && prLive

  return {
    hasWorkflowAccess: canPerformWorkflowActions,
    canSubmit,
    canWithdraw,
    canDelete,
    canApprove,
    canRequestChanges,
  }
}

export interface BranchManagerProps {
  branches: BranchSummary[]
  mode: OperatingMode
  /** Current user context for permission checks */
  user?: UserContext
  /** The branch the editor has open: listed first, marked, and offered its workflow action rather than Open. */
  currentBranchName?: string
  /** Why the open branch's Submit or Withdraw must wait, such as a Save all still writing it. */
  currentWorkflowBlockedReason?: string
  /** Opens on the new-branch form, its name field focused, as New branch… in the branch bar asks. */
  startCreating?: boolean
  onSelect?: (name: string) => void
  /** Awaited before the spinner starts, so a confirmation it shows never reads as a hung create. `false` abandons the create. */
  onBeforeCreate?: () => Promise<boolean>
  /**
   * Resolving `false` means the branch was not created, so the form stays open
   * with the user's values; any other return (including none) closes it.
   */
  onCreate?: (branch: {
    name: string
    title?: string
    description?: string
  }) => Promise<boolean> | void
  onDelete?: (name: string) => void
  onSubmit?: (name: string) => void
  onWithdraw?: (name: string) => void
  onApprove?: (name: string) => void
  onRequestChanges?: (name: string) => void
  onClose?: () => void
  comments?: CommentThread[]
  currentUserId?: string
  /** Whether the user may resolve any comment thread; a thread's author always may resolve it. */
  canResolve?: boolean
  onAddComment?: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryPath?: string,
    canopyPath?: string,
    threadId?: string,
  ) => Promise<void>
  onResolveThread?: (threadId: string) => Promise<void>
  highlightThreadId?: string
  /** Names people without `onGetOwnerMetadata`; with neither, access users are counted and owners read "Name unavailable" */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** Names branch owners and access users; the branch listing seeds owners only */
  onGetOwnerMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** Names the people in branch comments; without it they show as ids */
  onGetCommentUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
}

/** The lookup when a card has none: an owner reads "Name unavailable" and access users are counted, not named. */
const noUserLookup = async (): Promise<UserSearchResult | null> => null

interface BranchWorkflowAction {
  label: string
  color: string
  testId: string
  run: () => void
  /** Why it cannot act now; undefined when it can. */
  blockedReason?: string
  /** In a menu, the reason is printed by the item above, which blocks for the same one. */
  reasonShownAbove?: boolean
}

/**
 * The workflow action a branch's status calls for, or undefined when none applies: Submit for
 * an unprotected branch in editing, Withdraw once it is in review. 'approved' withdraws too, as
 * its only non-destructive exit. A user without workflow access is offered neither, since it
 * would never apply to them; a reason is given only for a block that depends on the branch's state.
 */
const workflowAction = (
  b: BranchSummary,
  perms: ReturnType<typeof getBranchPermissions>,
  onSubmit: ((name: string) => void) | undefined,
  onWithdraw: ((name: string) => void) | undefined,
): BranchWorkflowAction | undefined => {
  if (!perms.hasWorkflowAccess) return undefined
  if (b.status === 'submitted' || b.status === 'approved') {
    return {
      label: EDITOR_ACTIONS.withdrawFromReview,
      color: 'orange',
      testId: `withdraw-branch-button-${b.name}`,
      run: () => onWithdraw?.(b.name),
    }
  }
  if (b.status === 'editing' && !b.isProtected) {
    return {
      label: EDITOR_ACTIONS.submitForReview,
      color: 'brand',
      testId: `submit-branch-button-${b.name}`,
      run: () => onSubmit?.(b.name),
      blockedReason: perms.canSubmit ? undefined : "This branch can't be submitted right now.",
    }
  }
  return undefined
}

/** Whether `user` reviews `b` rather than owns it; see `isReviewerOfOthersReview`. */
const reviewsOthersBranch = (b: BranchSummary, user: UserContext | undefined): boolean =>
  isReviewerOfOthersReview(
    {
      status: b.status,
      createdBy: b.createdBy,
      users: b.access?.users,
      groups: b.access?.groups,
      isProtected: b.isProtected,
      pullRequestState: b.pullRequestState,
    },
    user,
  )

interface BranchCardProps {
  branch: BranchSummary
  isCurrent: boolean
  workflowBlockedReason?: string
  user?: UserContext
  onSelect?: (name: string) => void
  onSubmit?: (name: string) => void
  onWithdraw?: (name: string) => void
  onApprove?: (name: string) => void
  onRequestChanges?: (name: string) => void
  onDelete?: (name: string) => void
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  onGetOwnerMetadata?: (userId: string) => Promise<UserSearchResult | null>
}

/**
 * One branch: its state, and one primary action, with the rest in a "…" menu. The current branch
 * shows its workflow action; to a reviewer of someone else's submission it shows Approve, with
 * Request changes beside it (Request changes alone once approved). Another such branch shows that
 * reviewer Review, which opens it; the other cards show Open, which the current one never needs.
 * No action is shown twice.
 */
const BranchCard: React.FC<BranchCardProps> = ({
  branch: b,
  isCurrent,
  workflowBlockedReason,
  user,
  onSelect,
  onSubmit,
  onWithdraw,
  onApprove,
  onRequestChanges,
  onDelete,
  onGetUserMetadata,
  onGetOwnerMetadata = onGetUserMetadata,
}) => {
  const statusBadge = branchStatusPresentation(b.status, b.isProtected)
  const perms = getBranchPermissions(b, user)
  const action = workflowAction(b, perms, onSubmit, onWithdraw)
  const workflow =
    action && workflowBlockedReason ? { ...action, blockedReason: workflowBlockedReason } : action
  const userIsAdmin = isAdmin(user?.groups)

  // The open branch holds back its review actions as it does its workflow action; the reason is
  // given only for the open branch.
  const heldBack = (a: BranchWorkflowAction | undefined) =>
    a && workflowBlockedReason ? { ...a, blockedReason: workflowBlockedReason } : a
  // Shown to a reviewer other than the creator; the closed PR is the only thing that then blocks it.
  const reviewsOthers =
    isReviewer(user?.groups) && !!user && b.createdBy !== user.userId && !b.isProtected
  const approve: BranchWorkflowAction | undefined = heldBack(
    reviewsOthers && b.status === 'submitted'
      ? {
          label: EDITOR_ACTIONS.approve,
          color: 'brand',
          testId: `approve-branch-button-${b.name}`,
          run: () => onApprove?.(b.name),
          blockedReason: perms.canApprove ? undefined : CLOSED_PULL_REQUEST_REASON,
        }
      : undefined,
  )
  const requestChanges: BranchWorkflowAction | undefined = heldBack(
    reviewsOthers && (b.status === 'submitted' || b.status === 'approved')
      ? {
          label: EDITOR_ACTIONS.requestChanges,
          color: 'orange',
          testId: `request-changes-branch-button-${b.name}`,
          run: () => onRequestChanges?.(b.name),
          blockedReason: perms.canRequestChanges ? undefined : CLOSED_PULL_REQUEST_REASON,
          // With Approve above it, blocked by the same closed pull request, the reason prints once.
          reasonShownAbove:
            !!approve && !perms.canApprove && b.pullRequestState === 'closed' ? true : undefined,
        }
      : undefined,
  )
  const reviewing = reviewsOthersBranch(b, user)
  // Reviewing the open branch: Approve leads with Request changes beside it, or Request changes
  // alone once approved. Reviewing another one, Review opens it and the actions wait in the menu.
  const primary = !isCurrent ? undefined : reviewing ? (approve ?? requestChanges) : workflow
  const secondary = isCurrent && reviewing && approve ? requestChanges : undefined
  // Two visible actions would crowd the title at the drawer's width, so they take a row below it.
  const actionRow = !!secondary
  const menuActions = [approve, requestChanges, workflow].filter(
    (a): a is BranchWorkflowAction => !!a && a !== primary && a !== secondary,
  )
  const showViewPullRequest = !!b.pullRequestUrl
  const showDelete = !b.isProtected && (userIsAdmin || (!!user && b.createdBy === user.userId))
  const hasMenu = menuActions.length > 0 || showViewPullRequest || showDelete
  const menuLabel = `More actions for ${b.name}`
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <Paper
      withBorder
      p="md"
      shadow="xs"
      aria-current={isCurrent ? 'true' : undefined}
      data-current={isCurrent || undefined}
      data-testid={`branch-list-item-${b.name}`}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4}>
          <Group gap="xs">
            <Text fw={600}>{b.name}</Text>
            {isCurrent && (
              <Badge color="brand" variant="filled" data-testid={`branch-current-badge-${b.name}`}>
                Current
              </Badge>
            )}
            {statusBadge && (
              <Badge
                color={statusBadge.color}
                variant={statusBadge.variant}
                data-testid={`branch-status-badge-${b.name}`}
                data-status={b.status}
                data-protected={b.isProtected || undefined}
              >
                {statusBadge.label}
              </Badge>
            )}
            {b.status === 'archived' && b.mergedAt && (
              <Badge color="teal" variant="light" data-testid={`branch-merged-badge-${b.name}`}>
                Merged
              </Badge>
            )}
            {b.pullRequestNumber && (
              <Badge
                color={
                  b.pullRequestState === 'closed'
                    ? 'red'
                    : b.pullRequestState === 'merged'
                      ? 'violet'
                      : 'blue'
                }
                variant="light"
              >
                PR #{b.pullRequestNumber}
                {b.pullRequestState === 'closed' ? ' (closed)' : ''}
              </Badge>
            )}
            {b.commentCount !== undefined && b.commentCount > 0 && (
              <Badge color="grape" variant="light">
                {b.commentCount} {b.commentCount === 1 ? 'comment' : 'comments'}
              </Badge>
            )}
            {b.syncStatus === 'sync-failed' && (
              <Tooltip
                label="GitHub sync failed — an admin can retry it from System health."
                disabled={Boolean(b.syncFailureReason)}
                multiline
                maw={320}
              >
                <Badge color="red" variant="light" data-testid={`sync-failed-badge-${b.name}`}>
                  Sync failed
                </Badge>
              </Tooltip>
            )}
            {b.syncStatus === 'pending-sync' && (
              <Tooltip label="Changes are on their way to GitHub.">
                <Badge color="gray" variant="light" data-testid={`pending-sync-badge-${b.name}`}>
                  Syncing…
                </Badge>
              </Tooltip>
            )}
            {b.conflictStatus === 'conflicts-detected' && (
              <Tooltip label="This branch's version was kept for conflicting entries during a rebase — review the flagged entries.">
                <Badge color="orange" variant="light" data-testid={`conflicts-badge-${b.name}`}>
                  Conflicts
                  {b.conflictFiles?.length ? ` (${b.conflictFiles.length})` : ''}
                </Badge>
              </Tooltip>
            )}
          </Group>
          {b.syncStatus === 'sync-failed' && b.syncFailureReason && (
            <Text
              size="xs"
              c="var(--canopy-danger-text)"
              maw={480}
              data-testid={`sync-failed-reason-${b.name}`}
            >
              {b.syncFailureReason}
              {b.status === 'submitted' && ' Withdraw it from review to make changes.'}
            </Text>
          )}
          <Group gap="xs" align="center">
            {b.updatedAt && (
              <RelativeTime iso={b.updatedAt} prefix="Updated " size="xs" c="dimmed" />
            )}
            {b.createdBy && (
              <Group gap="xs" align="center" wrap="nowrap">
                <Text size="xs" c="dimmed">
                  •
                </Text>
                <Group gap={4} align="center" wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    Owner:
                  </Text>
                  <UserBadge
                    userId={b.createdBy}
                    getUserMetadata={onGetOwnerMetadata ?? noUserLookup}
                    variant="avatar-name"
                    size="xs"
                    showEmailTooltip={true}
                    showBadge={true}
                    badgeVariant="light"
                    color="gray"
                  />
                </Group>
              </Group>
            )}
          </Group>
          {b.access && (
            <BranchAccessList
              users={b.access.users}
              groups={b.access.groups}
              withheldUsers={b.access.withheldUsers}
              withheldGroups={b.access.withheldGroups}
              getUserMetadata={onGetOwnerMetadata ?? noUserLookup}
            />
          )}
        </Stack>
        <Group gap={8} wrap="nowrap">
          {!isCurrent && (
            <Button
              variant="light"
              onClick={() => onSelect?.(b.name)}
              data-testid={
                reviewing ? `review-branch-button-${b.name}` : `switch-to-branch-button-${b.name}`
              }
            >
              {reviewing ? EDITOR_ACTIONS.review : 'Open'}
            </Button>
          )}
          {!actionRow && primary && <CardActionButton action={primary} />}
          {hasMenu && (
            <Menu withinPortal shadow="sm" position="bottom-end" width={280} onChange={setMenuOpen}>
              <Tooltip label={menuLabel} disabled={menuOpen}>
                <Menu.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={menuLabel}
                    data-testid={`branch-actions-menu-${b.name}`}
                  >
                    <IconDots size={16} aria-hidden />
                  </ActionIcon>
                </Menu.Target>
              </Tooltip>
              <Menu.Dropdown>
                {menuActions.map((action) => (
                  <ReasonedMenuItem
                    key={action.testId}
                    blockedReason={action.blockedReason}
                    showReason={!action.reasonShownAbove}
                    onClick={action.run}
                    data-testid={action.testId}
                  >
                    {action.label}
                  </ReasonedMenuItem>
                ))}
                {showViewPullRequest && (
                  <Menu.Item
                    component="a"
                    href={b.pullRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    leftSection={<IconExternalLink size={14} aria-hidden />}
                    data-testid={`view-pull-request-${b.name}`}
                  >
                    {b.pullRequestNumber
                      ? `View pull request #${b.pullRequestNumber}`
                      : 'View pull request'}
                  </Menu.Item>
                )}
                {showDelete && (
                  <>
                    {(menuActions.length > 0 || showViewPullRequest) && <Menu.Divider />}
                    <DestructiveMenuItem
                      data-testid={`delete-branch-button-${b.name}`}
                      blockedReason={
                        b.status === 'submitted' || b.status === 'approved'
                          ? 'This branch is in review. Withdraw it from review before deleting it.'
                          : undefined
                      }
                      onClick={() => onDelete?.(b.name)}
                    >
                      Delete branch
                    </DestructiveMenuItem>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </Group>
      {actionRow && (
        <Group
          justify="flex-end"
          gap={8}
          wrap="nowrap"
          mt="sm"
          data-testid={`branch-action-row-${b.name}`}
        >
          {secondary && <CardActionButton action={secondary} />}
          {primary && <CardActionButton action={primary} />}
        </Group>
      )}
    </Paper>
  )
}

const CardActionButton: React.FC<{ action: BranchWorkflowAction }> = ({ action }) => (
  <Tooltip label={action.blockedReason} disabled={!action.blockedReason} multiline maw={280}>
    <Button
      variant="light"
      color={action.color}
      onClick={() => {
        if (!action.blockedReason) action.run()
      }}
      data-disabled={action.blockedReason ? true : undefined}
      aria-disabled={action.blockedReason ? true : undefined}
      data-testid={action.testId}
    >
      {action.label}
    </Button>
  </Tooltip>
)

export const BranchManager: React.FC<BranchManagerProps> = ({
  branches,
  mode,
  user,
  currentBranchName,
  currentWorkflowBlockedReason,
  startCreating = false,
  onSelect,
  onBeforeCreate,
  onCreate,
  onDelete,
  onSubmit,
  onWithdraw,
  onApprove,
  onRequestChanges,
  onClose: _,
  comments = [],
  currentUserId,
  canResolve = false,
  onAddComment,
  onResolveThread,
  highlightThreadId,
  onGetUserMetadata,
  onGetOwnerMetadata,
  onGetCommentUserMetadata,
}) => {
  const supportsBranching = clientOperatingStrategy(mode).supportsBranching()
  const [showCreateForm, setShowCreateForm] = useState(startCreating)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchTitle, setNewBranchTitle] = useState('')
  const [newBranchDescription, setNewBranchDescription] = useState('')

  const [creating, setCreating] = useState(false)
  // Read synchronously: state would not yet show a first click to a second one in the same tick.
  const creatingRef = useRef(false)

  const handleCreate = async () => {
    if (creatingRef.current || !newBranchName.trim()) return
    creatingRef.current = true
    try {
      if (onBeforeCreate && !(await onBeforeCreate())) return
      setCreating(true)
      const created = await onCreate?.({
        name: newBranchName.trim(),
        title: newBranchTitle.trim() || undefined,
        description: newBranchDescription.trim() || undefined,
      })
      if (created === false) return
      setNewBranchName('')
      setNewBranchTitle('')
      setNewBranchDescription('')
      setShowCreateForm(false)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  const orderedBranches = currentBranchName
    ? [
        ...branches.filter((b) => b.name === currentBranchName),
        ...branches.filter((b) => b.name !== currentBranchName),
      ]
    : branches

  const hasBranchThreads = comments.some((t) => t.type === 'branch')

  return (
    <Stack
      h="100%"
      style={{ display: 'flex', flexDirection: 'column' }}
      gap={0}
      data-testid="branch-manager"
    >
      {currentUserId && onAddComment && onResolveThread && hasBranchThreads && (
        <Stack pt="sm">
          <BranchComments
            comments={comments}
            currentUserId={currentUserId}
            canResolve={canResolve}
            onAddComment={onAddComment}
            onResolveThread={onResolveThread}
            highlightThreadId={highlightThreadId}
            onGetUserMetadata={onGetCommentUserMetadata}
          />
        </Stack>
      )}

      {!!supportsBranching && (
        <Stack gap="sm" pt="sm">
          <Button
            variant="light"
            size="sm"
            fullWidth
            onClick={() => setShowCreateForm(!showCreateForm)}
            disabled={creating}
            data-testid="create-branch-button"
          >
            {showCreateForm ? 'Cancel' : `${EDITOR_ACTIONS.newBranch}…`}
          </Button>

          <Collapse in={showCreateForm}>
            <Paper withBorder p="md">
              <Stack gap="sm">
                <TextInput
                  label="Branch name"
                  placeholder="feature/my-branch"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  required
                  disabled={creating}
                  data-autofocus={startCreating || undefined}
                  data-testid="branch-name-input"
                />
                <TextInput
                  label="Title"
                  placeholder="Brief description"
                  value={newBranchTitle}
                  onChange={(e) => setNewBranchTitle(e.target.value)}
                  disabled={creating}
                  data-testid="branch-title-input"
                />
                <Textarea
                  label="Description"
                  placeholder="Detailed description of the changes"
                  value={newBranchDescription}
                  onChange={(e) => setNewBranchDescription(e.target.value)}
                  minRows={2}
                  disabled={creating}
                  data-testid="branch-description-textarea"
                />
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={!newBranchName.trim()}
                  loading={creating}
                  fullWidth
                  data-testid="create-branch-submit"
                >
                  Create branch
                </Button>
              </Stack>
            </Paper>
          </Collapse>
        </Stack>
      )}

      <ScrollArea style={{ flex: 1 }} pb="md">
        {branches.length === 0 ? (
          <Text size="sm" c="dimmed" py="md">
            {!supportsBranching ? 'Branch management is not available.' : 'No branches available.'}
          </Text>
        ) : (
          <Stack gap="sm">
            {orderedBranches.map((b) => (
              <BranchCard
                key={b.name}
                branch={b}
                isCurrent={b.name === currentBranchName}
                workflowBlockedReason={
                  b.name === currentBranchName ? currentWorkflowBlockedReason : undefined
                }
                user={user}
                onSelect={onSelect}
                onSubmit={onSubmit}
                onWithdraw={onWithdraw}
                onApprove={onApprove}
                onRequestChanges={onRequestChanges}
                onDelete={onDelete}
                onGetUserMetadata={onGetUserMetadata}
                onGetOwnerMetadata={onGetOwnerMetadata}
              />
            ))}
          </Stack>
        )}
      </ScrollArea>
    </Stack>
  )
}
