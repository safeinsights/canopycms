import { forwardRef } from 'react'
import { Badge, Box, Button, Group, Menu, Paper, Stack, Text, Title, Tooltip } from '@mantine/core'
import { MdFolderOpen, MdKeyboardArrowDown } from 'react-icons/md'
import { GoGitBranch } from 'react-icons/go'
import type { OperatingMode } from '../../operating-mode'
import type { BranchStatus } from '../../types'
import type { EditorEntry } from '../Editor'
import { clientOperatingStrategy } from '../../operating-mode/client'

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
  editedFiles: Array<{ path: string; label: string }>

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
    locked: 'yellow',
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
    unresolvedCommentCount,
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
  }: EditorHeaderProps,
  ref,
) {
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
                    leftSection={<MdFolderOpen size={16} />}
                    rightSection={<MdKeyboardArrowDown size={14} />}
                  >
                    {currentEntry?.label ?? 'No file selected'}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={onFileReload} disabled={!branchName || !currentEntry}>
                    Reload File
                  </Menu.Item>
                  <Menu.Item onClick={onFileDiscardDraft} disabled={!currentEntry}>
                    Discard File Draft
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item data-testid="all-files-menu-item" onClick={onNavigatorOpen}>
                    All Files
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item disabled>{'TODO: replace with real modified file list'}</Menu.Item>
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
                    leftSection={<GoGitBranch size={16} />}
                    rightSection={<MdKeyboardArrowDown size={14} />}
                    disabled={!branchName}
                    data-testid="branch-dropdown-button"
                  >
                    {branchName || 'No branch selected'}
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
                  <Menu.Label>{`${modifiedCount} files modified`}</Menu.Label>
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
                  <Menu.Divider />
                  <Menu.Item disabled>{'TODO: replace with real modified file list'}</Menu.Item>
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
              label={!hasUnsavedChanges && currentEntry ? 'No changes to save' : ''}
              disabled={hasUnsavedChanges || !currentEntry}
            >
              <Button
                data-testid="save-button"
                variant="light"
                size="sm"
                onClick={onSave}
                disabled={!branchName || !currentEntry || busy || !hasUnsavedChanges}
              >
                Save File
              </Button>
            </Tooltip>
            {(() => {
              const isSubmitted = branchStatus === 'submitted'
              const isEditing = branchStatus === 'editing'

              // Check if user can perform workflow actions (creator OR ACL access OR system branch)
              const userIsCreator = userContext?.userId === branchCreatedBy
              const isSystemBranch = branchCreatedBy === 'canopycms-system'
              const userInACL =
                userContext &&
                branchAccess &&
                (branchAccess.allowedUsers?.includes(userContext.userId) ||
                  userContext.groups?.some((g) => branchAccess.allowedGroups?.includes(g)))

              const canPerformAction =
                (userIsCreator || userInACL || isSystemBranch) && (isEditing || isSubmitted)

              return (
                <Tooltip
                  label={
                    !canPerformAction
                      ? 'You do not have permission to submit or withdraw this branch'
                      : ''
                  }
                  disabled={canPerformAction}
                >
                  <Button
                    size="sm"
                    color={isSubmitted ? 'orange' : 'brand'}
                    onClick={isSubmitted ? onWithdraw : onSubmit}
                    disabled={!branchName || busy || !canPerformAction}
                    data-testid={isSubmitted ? 'withdraw-button' : 'submit-button'}
                  >
                    {isSubmitted ? 'Withdraw Branch...' : 'Submit Branch...'}
                  </Button>
                </Tooltip>
              )
            })()}
          </Group>
        </Group>
      </Box>
    </Paper>
  )
})
