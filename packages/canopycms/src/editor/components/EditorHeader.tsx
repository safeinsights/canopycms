import { forwardRef, type Ref } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Indicator,
  Menu,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core'
import { IconFolderOpen, IconChevronDown, IconGitBranch, IconLock } from '@tabler/icons-react'
import type { OperatingMode } from '../../operating-mode'
import type { BranchStatus } from '../../types'
import type { EditorEntry } from '../Editor'
import type { LogicalPath } from '../../paths/types'
import { clientOperatingStrategy } from '../../operating-mode/client'
import { isAdmin, isReviewer } from '../../authorization/helpers'
import { branchStatusPresentation } from '../branch-status'
import { EDITOR_ACTIONS } from '../copy'
import { SYSTEM_USER_ID } from '../../system-users'
import { ReasonedMenuItem } from './ReasonedMenuItem'

export interface EditorHeaderProps {
  /**
   * Site title displayed in the top-left.
   */
  siteTitle: string

  /**
   * Optional site subtitle displayed below the title.
   */
  siteSubtitle?: string

  /**
   * Main header title displayed in the center.
   */
  headerTitle: string

  /**
   * Currently selected entry.
   */
  currentEntry: EditorEntry | undefined

  /**
   * Current branch name.
   */
  branchName: string

  /**
   * Operating mode.
   */
  operatingMode: OperatingMode

  /**
   * Whether operations are currently in progress.
   */
  busy: boolean

  /**
   * Breadcrumb segments to display.
   */
  breadcrumbSegments: string[]

  /**
   * List of edited files.
   */
  editedFiles: Array<{ path: LogicalPath; label: string }>

  /**
   * Number of modified files.
   */
  modifiedCount: number

  /**
   * Number of unresolved comments.
   */
  unresolvedCommentCount: number

  /**
   * Unresolved comments (for filtering).
   */
  comments: Array<{ resolved: boolean }>

  /**
   * Callback to open the entry navigator.
   */
  onNavigatorOpen: () => void

  /** Ref to the button whose menu opens the file navigator. */
  navigatorToggleRef?: Ref<HTMLButtonElement>

  /** Ref to the button whose menu opens the branch manager and discards all drafts. */
  branchToggleRef?: Ref<HTMLButtonElement>

  /**
   * Callback to reload the current file.
   */
  onFileReload: () => void

  /**
   * Callback to discard the current file draft.
   */
  onFileDiscardDraft: () => void

  /**
   * Callback when an entry is selected.
   */
  onEntrySelect: (id: string) => void

  /**
   * Callback to reload all branch data.
   */
  onBranchReloadData: () => void

  /**
   * Callback to discard all drafts.
   */
  onBranchDiscardDrafts: () => void

  /**
   * Callback to open the branch manager.
   */
  onBranchManagerOpen: () => void

  /**
   * Callback to open the comments panel.
   */
  onCommentsPanelOpen: () => void

  /**
   * Callback to save the current file.
   */
  onSave: () => void

  /**
   * Callback to submit/publish the branch.
   */
  onSubmit: () => void

  /**
   * Whether the current entry has unsaved changes.
   */
  hasUnsavedChanges: boolean
  /** Writing drafts to localStorage failed, so they live only in this tab. */
  draftStorageFailed?: boolean

  /**
   * Current branch status (undefined if unknown).
   */
  branchStatus: BranchStatus | undefined

  /**
   * Callback to withdraw the branch.
   */
  onWithdraw: () => void

  /**
   * Current user context for permission checks.
   */
  userContext?: { userId: string; groups?: string[] }

  /**
   * Branch creator user ID.
   */
  branchCreatedBy?: string

  /**
   * Branch access control lists.
   */
  branchAccess?: { allowedUsers?: string[]; allowedGroups?: string[] }

  /**
   * Whether the current branch is the protected base branch (see
   * authorization/protected-branch.ts). Hides the Submit button (Withdraw
   * stays, as the recovery path). Default false.
   */
  branchIsProtected?: boolean

  /**
   * Whether the current branch is read-only (protected base branch in prod).
   * Disables Save and shows the "create a branch" banner below. Default false.
   */
  branchReadOnly?: boolean

  /**
   * Server-computed: content writes are rejected on this branch, for either
   * reason (base-branch read-only, or a status past 'editing'). Combined with
   * `branchReadOnly` to pick which of the two banners to show. Default false.
   */
  branchWriteBlocked?: boolean
}

/**
 * Header component for the Editor.
 * Contains site info, file navigation, breadcrumbs, branch selector, comments button, and action buttons.
 */
export const EditorHeader = forwardRef<HTMLDivElement, EditorHeaderProps>(function EditorHeader(
  {
    siteTitle,
    siteSubtitle,
    headerTitle,
    currentEntry,
    branchName,
    operatingMode,
    busy,
    breadcrumbSegments,
    editedFiles,
    modifiedCount,
    unresolvedCommentCount: _,
    comments,
    onNavigatorOpen,
    navigatorToggleRef,
    branchToggleRef,
    onFileReload,
    onFileDiscardDraft,
    onEntrySelect,
    onBranchReloadData,
    onBranchDiscardDrafts,
    onBranchManagerOpen,
    onCommentsPanelOpen,
    onSave,
    onSubmit,
    hasUnsavedChanges,
    draftStorageFailed = false,
    branchStatus,
    onWithdraw,
    userContext,
    branchCreatedBy,
    branchAccess,
    branchIsProtected = false,
    branchReadOnly = false,
    branchWriteBlocked = false,
  }: EditorHeaderProps,
  ref,
) {
  // `branchWriteBlocked` is the server's own answer (getBranchProtection), so
  // Save is never enabled for a write the API would reject; a client-side
  // derivation could drift from it. `branchReadOnly` only picks which banner
  // to show -- base-branch read-only takes precedence over a workflow status
  // lock.
  const statusLocked = branchWriteBlocked && !branchReadOnly

  // Covers two cases where `branchStatus` can't be trusted to describe the lock
  // honestly: branch data still loading (`branchStatus` is undefined, so the
  // banner would otherwise interpolate "Branch is undefined...") and version
  // skew (an old server omits `branchWriteBlocked` while still reporting
  // status: 'editing', which would otherwise assert a lock the status
  // contradicts). In both cases the banner says data is unavailable instead.
  const branchDataUnavailable =
    statusLocked && (branchStatus === undefined || branchStatus === 'editing')

  // Save stays focusable while blocked (`aria-disabled`, not `disabled`), so its reason opens on
  // keyboard focus and touch as well as hover; the click does nothing.
  const saveBlocked =
    !branchName || !currentEntry || busy || !hasUnsavedChanges || branchReadOnly || statusLocked
  // Why Save is blocked, with the way forward. The Tooltip hides it while a save is in flight.
  const saveBlockedReason = branchReadOnly
    ? 'The base branch is read-only. Create a branch to make changes.'
    : branchDataUnavailable
      ? 'Branch details could not be loaded. Use "Switch branch…" to retry.'
      : statusLocked
        ? branchStatus === 'submitted'
          ? 'This branch is in review. Withdraw it to make changes.'
          : branchStatus === 'approved'
            ? 'This branch is approved. Withdraw it to make changes.'
            : `This branch is ${branchStatus}. Its content is read-only.`
        : !branchName
          ? 'Open a branch first.'
          : !currentEntry
            ? 'Open an entry to save it.'
            : !hasUnsavedChanges
              ? 'No changes to save.'
              : ''

  const statusPresentation = branchStatusPresentation(branchStatus, branchIsProtected)
  const unresolvedCount = comments.filter((t) => !t.resolved).length

  return (
    <Paper
      ref={ref}
      shadow="md"
      withBorder
      radius={0}
      px={0}
      py={0}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 70,
      }}
    >
      <Box px="md" py="sm">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Title order={5} style={{ lineHeight: 1.1 }}>
              {siteTitle}
            </Title>
            {siteSubtitle && (
              <Text size="xs" c="dimmed">
                {siteSubtitle}
              </Text>
            )}
          </Stack>
          <Stack gap={6} style={{ minWidth: 0, flex: 1, alignItems: 'center' }}>
            <Title order={4} style={{ lineHeight: 1.1 }}>
              {headerTitle}
            </Title>
            <Group
              gap="sm"
              wrap="wrap"
              align="center"
              style={{ minWidth: 0, justifyContent: 'center' }}
            >
              <Menu withinPortal shadow="sm">
                <Menu.Target>
                  <Button
                    ref={navigatorToggleRef}
                    data-testid="file-dropdown-button"
                    variant="outline"
                    color="gray"
                    leftSection={<IconFolderOpen size={16} />}
                    rightSection={<IconChevronDown size={14} />}
                  >
                    {currentEntry?.label ?? 'No entry selected'}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <ReasonedMenuItem
                    onClick={onFileReload}
                    blockedReason={
                      !branchName
                        ? 'Open a branch first.'
                        : !currentEntry
                          ? 'Open an entry first.'
                          : undefined
                    }
                  >
                    Reload entry
                  </ReasonedMenuItem>
                  <ReasonedMenuItem
                    data-testid="discard-file-draft-menu-item"
                    onClick={onFileDiscardDraft}
                    blockedReason={currentEntry ? undefined : 'Open an entry first.'}
                  >
                    Discard changes
                  </ReasonedMenuItem>
                  <Menu.Divider />
                  <Menu.Item data-testid="all-files-menu-item" onClick={onNavigatorOpen}>
                    All Files
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Label>Recently modified</Menu.Label>
                  {editedFiles.slice(0, 3).length === 0 ? (
                    <Text size="sm" c="dimmed" px="sm" py={6}>
                      No recently modified entries
                    </Text>
                  ) : (
                    editedFiles.slice(0, 3).map((file) => (
                      <Menu.Item key={file.path} onClick={() => onEntrySelect(file.path)}>
                        {file.label}
                      </Menu.Item>
                    ))
                  )}
                </Menu.Dropdown>
              </Menu>

              <Group gap={4} wrap="wrap" align="center" style={{ minWidth: 0 }}>
                {breadcrumbSegments.map((segment, idx) => (
                  <Group key={`${segment}-${idx}`} gap={4} align="center" wrap="nowrap">
                    {idx > 0 && (
                      <Text size="xs" c="dimmed">
                        /
                      </Text>
                    )}
                    <Button
                      variant="subtle"
                      px="xs"
                      onClick={onNavigatorOpen}
                      data-testid="breadcrumb-segment"
                    >
                      {segment}
                    </Button>
                  </Group>
                ))}
              </Group>

              <Menu withinPortal shadow="sm">
                <Menu.Target>
                  <Button
                    ref={branchToggleRef}
                    variant="outline"
                    color="gray"
                    leftSection={<IconGitBranch size={16} />}
                    rightSection={<IconChevronDown size={14} />}
                    loading={!branchName && busy}
                    data-testid="branch-dropdown-button"
                  >
                    {branchName || (busy ? 'Loading branches…' : 'No branch selected')}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown data-testid="branch-menu">
                  <ReasonedMenuItem
                    onClick={onBranchReloadData}
                    blockedReason={branchName ? undefined : 'Open a branch first.'}
                  >
                    Reload all entries
                  </ReasonedMenuItem>
                  <ReasonedMenuItem
                    data-testid="discard-all-drafts-menu-item"
                    onClick={onBranchDiscardDrafts}
                    blockedReason={branchName ? undefined : 'Open a branch first.'}
                  >
                    Discard all changes
                  </ReasonedMenuItem>
                  <Menu.Divider />
                  <Menu.Item onClick={onBranchManagerOpen} data-testid="manage-branches-menu-item">
                    {`${EDITOR_ACTIONS.switchBranch}…`}
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Label>{`${modifiedCount} ${modifiedCount === 1 ? 'entry' : 'entries'} modified`}</Menu.Label>
                  {editedFiles.length === 0 ? (
                    <Text size="sm" c="dimmed" px="sm" py={6}>
                      No edited entries yet
                    </Text>
                  ) : (
                    editedFiles.map((file) => (
                      <Menu.Item
                        key={`branch-mod-${file.path}`}
                        onClick={() => onEntrySelect(file.path)}
                      >
                        {file.label}
                      </Menu.Item>
                    ))
                  )}
                </Menu.Dropdown>
              </Menu>

              {clientOperatingStrategy(operatingMode ?? 'prod').supportsStatusBadge() &&
                branchName &&
                statusPresentation && (
                  <Badge
                    color={statusPresentation.color}
                    variant={statusPresentation.variant}
                    size="sm"
                    data-testid={`header-status-badge-${branchIsProtected ? 'protected' : branchStatus}`}
                    data-status={branchIsProtected ? 'protected' : branchStatus}
                  >
                    {statusPresentation.label}
                  </Badge>
                )}

              {clientOperatingStrategy(operatingMode ?? 'prod').supportsComments() &&
                branchName && (
                  <Indicator
                    label={<span data-testid="comments-unresolved-count">{unresolvedCount}</span>}
                    size={18}
                    color="brand"
                    disabled={unresolvedCount === 0}
                    styles={{ indicator: { pointerEvents: 'none' } }}
                  >
                    <Button
                      variant="outline"
                      color="gray"
                      onClick={onCommentsPanelOpen}
                      data-testid="comments-button"
                      aria-label={
                        unresolvedCount > 0 ? `Comments, ${unresolvedCount} unresolved` : undefined
                      }
                    >
                      Comments
                    </Button>
                  </Indicator>
                )}
            </Group>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            {/* Always mounted at a fixed width, so the first keystroke shifts nothing. */}
            <Box role="status" w={112} ta="right">
              {hasUnsavedChanges && (
                <Tooltip
                  label="Your browser couldn't store these changes. Save before you leave or reload, or they'll be lost."
                  disabled={!draftStorageFailed}
                  multiline
                  w={260}
                >
                  <Text
                    size="xs"
                    lh={1.2}
                    c={draftStorageFailed ? 'red.9' : 'dimmed'}
                    data-testid="unsaved-indicator"
                  >
                    {draftStorageFailed
                      ? 'Unsaved · not kept on this device'
                      : 'Unsaved · kept on this device'}
                    {draftStorageFailed && (
                      <VisuallyHidden component="span">
                        . Save before you leave or reload, or they&apos;ll be lost.
                      </VisuallyHidden>
                    )}
                  </Text>
                </Tooltip>
              )}
            </Box>
            <Tooltip
              label={saveBlockedReason}
              disabled={!saveBlocked || busy}
              events={{ hover: true, focus: true, touch: true }}
              multiline
              maw={280}
            >
              <Button
                data-testid="save-button"
                variant="light"
                size="sm"
                onClick={() => {
                  if (!saveBlocked) onSave()
                }}
                data-disabled={saveBlocked ? true : undefined}
                aria-disabled={saveBlocked ? true : undefined}
              >
                {EDITOR_ACTIONS.save}
              </Button>
            </Tooltip>
            {(() => {
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
              // admin/reviewer -- Admins/Reviewers must be able to withdraw a protected
              // base branch stuck in 'submitted' even without ACL access. Mirrors the
              // server's canPerformWorkflowAction (BranchManager.tsx), which is the
              // actual enforcer; this only decides whether to show the control disabled.
              const userIsCreator = userContext?.userId === branchCreatedBy
              const isSystemBranch = branchCreatedBy === SYSTEM_USER_ID && !branchIsProtected
              const userInACL =
                userContext &&
                branchAccess &&
                (branchAccess.allowedUsers?.includes(userContext.userId) ||
                  userContext.groups?.some((g) => branchAccess.allowedGroups?.includes(g)))
              const userIsPrivileged =
                !!userContext &&
                (isAdmin(userContext.groups ?? []) || isReviewer(userContext.groups ?? []))

              const userHasPermission =
                userIsCreator || userInACL || isSystemBranch || userIsPrivileged
              // A status with no available transition (today: 'archived') is a
              // separate condition from lacking permission, and conflating them
              // sent people to an admin to fix a non-permissions problem.
              const statusHasAction = isEditing || isWithdrawable
              const canPerformAction = userHasPermission && statusHasAction
              // Blocked, it stays focusable (`aria-disabled`), so its reason opens on focus.
              const actionBlocked = !branchName || busy || !canPerformAction

              return (
                <Tooltip
                  label={
                    // No branch data (`branchStatus === undefined`) must not be
                    // interpolated raw into this label. Guarded explicitly here rather
                    // than left to the early return above, which hides this button
                    // today only as a side effect of `branchIsProtected`'s `?? true`
                    // default -- not a guarantee this arm stays unreachable.
                    branchStatus === undefined
                      ? 'Branch details could not be loaded. Use "Switch branch…" to retry.'
                      : !statusHasAction
                        ? `This branch is ${branchStatus}, so it can't be submitted for review or withdrawn from review.`
                        : !userHasPermission
                          ? 'You do not have permission to submit this branch for review or withdraw it from review. Ask an admin for access.'
                          : ''
                  }
                  disabled={canPerformAction}
                  events={{ hover: true, focus: true, touch: true }}
                  multiline
                  maw={320}
                >
                  <Button
                    size="sm"
                    color={isWithdrawable ? 'orange' : 'brand'}
                    onClick={() => {
                      if (actionBlocked) return
                      if (isWithdrawable) onWithdraw()
                      else onSubmit()
                    }}
                    data-disabled={actionBlocked ? true : undefined}
                    aria-disabled={actionBlocked ? true : undefined}
                    data-testid={isWithdrawable ? 'withdraw-button' : 'submit-button'}
                  >
                    {isWithdrawable
                      ? EDITOR_ACTIONS.withdrawFromReview
                      : EDITOR_ACTIONS.submitForReview}
                  </Button>
                </Tooltip>
              )
            })()}
          </Group>
        </Group>
        {branchReadOnly && (
          <Alert
            icon={<IconLock size={16} />}
            color="yellow"
            variant="light"
            mt="sm"
            data-testid="protected-branch-banner"
          >
            <Group justify="space-between" align="center" gap="sm" wrap="wrap">
              <Text size="sm">
                {`You are viewing the protected base branch "${branchName}". Content is read-only — create a branch to make changes.`}
              </Text>
              <Button variant="default" onClick={onBranchManagerOpen}>
                {`${EDITOR_ACTIONS.newBranch}…`}
              </Button>
            </Group>
          </Alert>
        )}
        {statusLocked && (
          <Alert
            icon={<IconLock size={16} />}
            color="yellow"
            variant="light"
            mt="sm"
            data-testid="status-locked-banner"
          >
            <Group justify="space-between" align="center" gap="sm" wrap="wrap">
              <Text size="sm">
                {branchDataUnavailable
                  ? `Branch details for "${branchName}" could not be loaded, so content is locked until they arrive. Use Switch branch… to retry.`
                  : branchStatus === 'submitted'
                    ? `Branch "${branchName}" is submitted for review and locked for edits. Withdraw it from review to make changes.`
                    : `Branch "${branchName}" is ${branchStatus} — content is read-only.`}
              </Text>
              <Button variant="default" onClick={onBranchManagerOpen}>
                {`${EDITOR_ACTIONS.switchBranch}…`}
              </Button>
            </Group>
          </Alert>
        )}
      </Box>
    </Paper>
  )
})
