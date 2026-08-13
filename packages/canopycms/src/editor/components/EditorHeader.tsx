import { forwardRef } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core'
import { IconFolderOpen, IconChevronDown, IconGitBranch, IconLock } from '@tabler/icons-react'
import type { OperatingMode } from '../../operating-mode'
import type { BranchStatus } from '../../types'
import type { EditorEntry } from '../Editor'
import type { LogicalPath } from '../../paths/types'
import { clientOperatingStrategy } from '../../operating-mode/client'
import { isAdmin, isReviewer } from '../../authorization/helpers'

/**
 * Props for the EditorHeader component.
 */
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
 * Status color map matching BranchManager.tsx pattern.
 * Returns the Mantine color string for a given branch status.
 */
const getStatusColor = (status: BranchStatus): string => {
  const statusColorMap: Record<BranchStatus, string> = {
    editing: 'brand',
    submitted: 'green',
    approved: 'teal',
    archived: 'gray',
  }
  return statusColorMap[status] ?? 'gray'
}

/**
 * Header component for the Editor.
 * Contains site info, file navigation, breadcrumbs, branch selector, comments button, and action buttons.
 *
 * @example
 * ```tsx
 * <EditorHeader
 *   siteTitle="My Site"
 *   siteSubtitle="CMS"
 *   headerTitle="Edit Content"
 *   currentEntry={currentEntry}
 *   branchName="main"
 *   operatingMode="collaboration"
 *   busy={false}
 *   breadcrumbSegments={['Posts', 'My Post']}
 *   editedFiles={[]}
 *   modifiedCount={0}
 *   unresolvedCommentCount={0}
 *   comments={[]}
 *   onNavigatorOpen={() => setNavigatorOpen(true)}
 *   onFileReload={handleReload}
 *   onFileDiscardDraft={handleDiscardFileDraft}
 *   onEntrySelect={setSelectedId}
 *   onBranchReloadData={handleReloadBranchData}
 *   onBranchDiscardDrafts={handleDiscardDrafts}
 *   onBranchManagerOpen={() => setBranchManagerOpen(true)}
 *   onCommentsPanelOpen={() => setCommentsPanelOpen(true)}
 *   onSave={handleSave}
 *   onSubmit={() => handleSubmit(branchName)}
 * />
 * ```
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
  // `branchWriteBlocked` is the server's own answer (getBranchProtection, the
  // same call the writableBranch guard makes), so Save can never be enabled for
  // a write the API would reject. `branchReadOnly` only picks WHICH banner: the
  // base branch's is a structural property and takes precedence over a workflow
  // status lock.
  const statusLocked = branchWriteBlocked && !branchReadOnly

  // The lock now fails CLOSED while the branch list is unresolved (Editor.tsx's
  // `branchContentLocked` is `?? true`), which is right -- but `branchStatus` is
  // `currentBranch?.status`, i.e. undefined in that same window. Without this
  // distinction every banner and tooltip below interpolated it directly and read
  // `Branch "main" is undefined - content is read-only`, on ordinary initial load
  // and permanently after a failed branches fetch. Worse under version skew,
  // where the status IS known ('editing') and the copy would assert a status
  // lock the status plainly contradicts. So: locked, but say why honestly.
  const branchDataUnavailable = statusLocked && branchStatus === undefined

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
                    data-testid="file-dropdown-button"
                    variant="outline"
                    color="gray"
                    size="xs"
                    leftSection={<IconFolderOpen size={16} />}
                    rightSection={<IconChevronDown size={14} />}
                  >
                    {currentEntry?.label ?? 'No file selected'}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={onFileReload} disabled={!branchName || !currentEntry}>
                    Reload File
                  </Menu.Item>
                  <Menu.Item
                    data-testid="discard-file-draft-menu-item"
                    onClick={onFileDiscardDraft}
                    disabled={!currentEntry}
                  >
                    Discard File Draft
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item data-testid="all-files-menu-item" onClick={onNavigatorOpen}>
                    All Files
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Label>Recently modified</Menu.Label>
                  {editedFiles.slice(0, 3).length === 0 ? (
                    <Menu.Item disabled>&lt;none&gt;</Menu.Item>
                  ) : (
                    editedFiles.slice(0, 3).map((file) => (
                      <Menu.Item
                        key={file.path}
                        onClick={() => {
                          onEntrySelect(file.path)
                          onNavigatorOpen()
                        }}
                      >
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
                    <Button variant="subtle" size="xs" px="xs" onClick={onNavigatorOpen}>
                      {segment}
                    </Button>
                  </Group>
                ))}
              </Group>

              <Menu withinPortal shadow="sm">
                <Menu.Target>
                  <Button
                    variant="outline"
                    color="gray"
                    size="xs"
                    leftSection={<IconGitBranch size={16} />}
                    rightSection={<IconChevronDown size={14} />}
                    loading={!branchName && busy}
                    data-testid="branch-dropdown-button"
                  >
                    {branchName || (busy ? 'Loading branches…' : 'No branch selected')}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown data-testid="branch-menu">
                  <Menu.Item onClick={onBranchReloadData} disabled={!branchName}>
                    Reload All Files
                  </Menu.Item>
                  <Menu.Item onClick={onBranchDiscardDrafts} disabled={!branchName}>
                    Discard All File Drafts
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item onClick={onBranchManagerOpen} data-testid="manage-branches-menu-item">
                    Change / Manage Branches
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Label>{`${modifiedCount} file${modifiedCount === 1 ? '' : 's'} modified`}</Menu.Label>
                  {editedFiles.length === 0 ? (
                    <Menu.Item disabled>No edited files yet</Menu.Item>
                  ) : (
                    editedFiles.map((file) => (
                      <Menu.Item
                        key={`branch-mod-${file.path}`}
                        onClick={() => {
                          onEntrySelect(file.path)
                          onNavigatorOpen()
                        }}
                      >
                        {file.label}
                      </Menu.Item>
                    ))
                  )}
                </Menu.Dropdown>
              </Menu>

              {clientOperatingStrategy(operatingMode ?? 'prod').supportsStatusBadge() &&
                branchName &&
                branchStatus && (
                  <Badge
                    color={getStatusColor(branchStatus)}
                    variant="light"
                    size="sm"
                    data-testid={`header-status-badge-${branchStatus}`}
                  >
                    {branchStatus}
                  </Badge>
                )}

              {clientOperatingStrategy(operatingMode ?? 'prod').supportsComments() &&
                branchName && (
                  <Button
                    variant="outline"
                    color="gray"
                    size="xs"
                    onClick={onCommentsPanelOpen}
                    style={{ position: 'relative' }}
                    data-testid="comments-button"
                  >
                    Comments
                    {comments.filter((t) => !t.resolved).length > 0 && (
                      <span
                        style={{
                          position: 'absolute',
                          top: -6,
                          right: -6,
                          background: 'var(--mantine-color-grape-6)',
                          color: 'white',
                          borderRadius: '50%',
                          width: 18,
                          height: 18,
                          fontSize: 10,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 600,
                        }}
                      >
                        {comments.filter((t) => !t.resolved).length}
                      </span>
                    )}
                  </Button>
                )}
            </Group>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Tooltip
              label={
                branchReadOnly
                  ? 'The base branch is read-only'
                  : branchDataUnavailable
                    ? 'Branch details are still loading — saving is disabled until they arrive'
                    : statusLocked
                      ? branchStatus === 'submitted'
                        ? 'This branch is submitted for review — withdraw it to make changes'
                        : `This branch is ${branchStatus} — content is read-only`
                      : !hasUnsavedChanges && currentEntry
                        ? 'No changes to save'
                        : ''
              }
              disabled={!branchReadOnly && !statusLocked && (hasUnsavedChanges || !currentEntry)}
            >
              <Button
                data-testid="save-button"
                variant="light"
                size="sm"
                onClick={onSave}
                disabled={
                  !branchName ||
                  !currentEntry ||
                  busy ||
                  !hasUnsavedChanges ||
                  branchReadOnly ||
                  statusLocked
                }
              >
                Save File
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

              // Check if user can perform workflow actions (creator OR ACL access OR system
              // branch OR privileged). Admins/Reviewers must be able to withdraw a protected
              // base branch wrongly stuck in 'submitted' -- the documented recovery flow --
              // even when they're neither its creator nor in its ACL; this mirrors the
              // server's canPerformWorkflowAction and BranchManager.tsx.
              const userIsCreator = userContext?.userId === branchCreatedBy
              const isSystemBranch = branchCreatedBy === 'canopycms-system' && !branchIsProtected
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

              return (
                <Tooltip
                  label={
                    // The unknown-status arm mirrors the banner's: with no
                    // branch data, `statusHasAction` is false (undefined is
                    // neither 'editing' nor withdrawable) and this label used
                    // to interpolate it as "This branch is undefined and has
                    // no submit or withdraw action available".
                    //
                    // Latent rather than live TODAY, and only by accident:
                    // Editor.tsx passes `branchIsProtected={... ?? true}` since
                    // the fail-closed change, so in that same window the early
                    // return above (`branchIsProtected && !isWithdrawable`)
                    // unmounts this button before the tooltip can render. That
                    // is one guard away from being user-visible -- relax the
                    // `?? true`, or pass `branchIsProtected={false}` from
                    // anywhere, and the copy is live. Guarding it here rather
                    // than relying on an unrelated condition to keep hiding it.
                    branchStatus === undefined
                      ? 'Branch data could not be loaded, so no submit or withdraw action is available'
                      : !statusHasAction
                        ? `This branch is ${branchStatus} and has no submit or withdraw action available`
                        : !userHasPermission
                          ? 'You do not have permission to submit or withdraw this branch'
                          : ''
                  }
                  disabled={canPerformAction}
                >
                  <Button
                    size="sm"
                    color={isWithdrawable ? 'orange' : 'brand'}
                    onClick={isWithdrawable ? onWithdraw : onSubmit}
                    disabled={!branchName || busy || !canPerformAction}
                    data-testid={isWithdrawable ? 'withdraw-button' : 'submit-button'}
                  >
                    {isWithdrawable ? 'Withdraw Branch...' : 'Submit Branch...'}
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
              <Button size="xs" variant="light" color="yellow" onClick={onBranchManagerOpen}>
                Create a branch
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
                  ? `Branch details for "${branchName}" could not be loaded, so content is locked until they arrive. Use Manage Branches to retry.`
                  : branchStatus === 'submitted'
                    ? `Branch "${branchName}" is submitted for review and locked for edits. Use Withdraw Branch above to resume editing.`
                    : `Branch "${branchName}" is ${branchStatus} — content is read-only.`}
              </Text>
              <Button size="xs" variant="light" color="yellow" onClick={onBranchManagerOpen}>
                Manage Branches
              </Button>
            </Group>
          </Alert>
        )}
      </Box>
    </Paper>
  )
})
