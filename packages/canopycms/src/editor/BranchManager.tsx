'use client'

import React, { useState } from 'react'

import {
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Textarea,
  Collapse,
  Tooltip,
} from '@mantine/core'
import type { OperatingMode } from '../operating-mode'
import type { CommentThread } from '../comment-store'
import type { UserSearchResult } from '../auth/types'
import { BranchComments } from './comments/BranchComments'
import { UserBadge } from './components/UserBadge'
// Import directly from helpers to avoid server-only code in authorization barrel
import { isAdmin, isReviewer } from '../authorization/helpers'
import { clientOperatingStrategy } from '../operating-mode/client'

export interface BranchSummary {
  name: string
  status: string
  createdBy?: string
  updatedAt?: string
  access?: {
    users?: string[]
    groups?: string[]
  }
  pullRequestUrl?: string
  pullRequestNumber?: number
  commentCount?: number
}

export interface UserContext {
  userId: string
  groups?: string[]
}

/**
 * Compute what actions the current user can perform on a branch.
 * Uses the same hybrid permission model as the backend:
 * - Creator can always submit/withdraw
 * - Users in branch ACL can submit/withdraw
 * - System branches can be submitted/withdrawn by anyone with access
 * - Admins/Reviewers always have access
 */
export const getBranchPermissions = (
  branch: BranchSummary,
  user: UserContext | undefined,
): {
  canSubmit: boolean
  canWithdraw: boolean
  canDelete: boolean
  canRequestChanges: boolean
} => {
  if (!user) {
    return { canSubmit: false, canWithdraw: false, canDelete: false, canRequestChanges: false }
  }

  const userIsAdmin = isAdmin(user.groups)
  const userIsReviewer = isReviewer(user.groups)
  const userIsCreator = branch.createdBy === user.userId
  const isSystemBranch = branch.createdBy === 'canopycms-system'

  // Check if user is in branch ACL
  const userInACL =
    (branch.access?.users?.includes(user.userId) ||
      user.groups?.some((g) => branch.access?.groups?.includes(g))) ??
    false

  // Can perform workflow actions if: creator OR in ACL OR (system branch AND has basic access) OR privileged
  const canPerformWorkflowActions =
    userIsCreator || userInACL || isSystemBranch || userIsAdmin || userIsReviewer

  // Submit: Can perform workflow actions AND branch is in editing status
  const canSubmit = canPerformWorkflowActions && branch.status === 'editing'

  // Withdraw: Can perform workflow actions AND branch is in submitted status
  const canWithdraw = canPerformWorkflowActions && branch.status === 'submitted'

  // Delete: Admin or creator (but not if submitted)
  const canDelete = (userIsAdmin || userIsCreator) && branch.status !== 'submitted'

  // Request changes: Only Reviewers or Admins can request changes on submitted branches
  const canRequestChanges = (userIsAdmin || userIsReviewer) && branch.status === 'submitted'

  return { canSubmit, canWithdraw, canDelete, canRequestChanges }
}

const statusColorMap: Record<string, { color: string; variant?: 'light' | 'filled' }> = {
  editing: { color: 'brand', variant: 'light' },
  submitted: { color: 'green', variant: 'light' },
  locked: { color: 'yellow', variant: 'light' },
}

export interface BranchManagerProps {
  branches: BranchSummary[]
  mode: OperatingMode
  /** Current user context for permission checks */
  user?: UserContext
  onSelect?: (name: string) => void
  onCreate?: (branch: { name: string; title?: string; description?: string }) => void
  onDelete?: (name: string) => void
  onSubmit?: (name: string) => void
  onWithdraw?: (name: string) => void
  onRequestChanges?: (name: string) => void
  onClose?: () => void
  // Branch comments
  comments?: CommentThread[]
  currentUserId?: string
  canResolve?: boolean
  onAddComment?: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryId?: string,
    canopyPath?: string,
    threadId?: string,
  ) => Promise<void>
  onResolveThread?: (threadId: string) => Promise<void>
  highlightThreadId?: string
  /** Optional function to fetch user metadata for displaying user badges */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
}

export const BranchManager: React.FC<BranchManagerProps> = ({
  branches,
  mode,
  user,
  onSelect,
  onCreate,
  onDelete,
  onSubmit,
  onWithdraw,
  onRequestChanges,
  onClose,
  comments = [],
  currentUserId,
  canResolve = false,
  onAddComment,
  onResolveThread,
  highlightThreadId,
  onGetUserMetadata,
}) => {
  const supportsBranching = clientOperatingStrategy(mode).supportsBranching()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchTitle, setNewBranchTitle] = useState('')
  const [newBranchDescription, setNewBranchDescription] = useState('')

  const handleCreate = () => {
    if (!newBranchName.trim()) return
    onCreate?.({
      name: newBranchName.trim(),
      title: newBranchTitle.trim() || undefined,
      description: newBranchDescription.trim() || undefined,
    })
    setNewBranchName('')
    setNewBranchTitle('')
    setNewBranchDescription('')
    setShowCreateForm(false)
  }

  return (
    <Stack
      h="100%"
      style={{ display: 'flex', flexDirection: 'column' }}
      gap={0}
      data-testid="branch-manager"
    >
      {/* Branch-level comments */}
      {currentUserId && onAddComment && onResolveThread && (
        <Stack pt="sm">
          <BranchComments
            comments={comments}
            currentUserId={currentUserId}
            canResolve={canResolve}
            onAddComment={onAddComment}
            onResolveThread={onResolveThread}
            highlightThreadId={highlightThreadId}
            onGetUserMetadata={onGetUserMetadata}
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
            data-testid="create-branch-button"
          >
            {showCreateForm ? 'Cancel' : 'Create New Branch'}
          </Button>

          <Collapse in={showCreateForm}>
            <Paper withBorder p="md" radius="md">
              <Stack gap="sm">
                <TextInput
                  label="Branch Name"
                  placeholder="feature/my-branch"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  required
                  data-testid="branch-name-input"
                />
                <TextInput
                  label="Title (optional)"
                  placeholder="Brief description"
                  value={newBranchTitle}
                  onChange={(e) => setNewBranchTitle(e.target.value)}
                  data-testid="branch-title-input"
                />
                <Textarea
                  label="Description (optional)"
                  placeholder="Detailed description of the changes"
                  value={newBranchDescription}
                  onChange={(e) => setNewBranchDescription(e.target.value)}
                  minRows={2}
                  data-testid="branch-description-textarea"
                />
                <Button
                  onClick={handleCreate}
                  disabled={!newBranchName.trim()}
                  fullWidth
                  data-testid="create-branch-submit"
                >
                  Create Branch
                </Button>
              </Stack>
            </Paper>
          </Collapse>
        </Stack>
      )}

      <ScrollArea style={{ flex: 1 }} pb="md">
        {branches.length === 0 ? (
          <Text size="sm" c="dimmed" py="md">
            {!supportsBranching
              ? 'Branch management is disabled in dev mode.'
              : 'No branches available.'}
          </Text>
        ) : (
          <Stack gap="sm">
            {branches.map((b) => {
              const statusColor = statusColorMap[b.status] ?? {
                color: 'neutral',
                variant: 'light' as const,
              }
              const perms = getBranchPermissions(b, user)
              return (
                <Paper
                  key={b.name}
                  withBorder
                  radius="md"
                  p="md"
                  shadow="xs"
                  data-testid={`branch-list-item-${b.name}`}
                >
                  <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                      <Group gap="xs">
                        <Text fw={600}>{b.name}</Text>
                        <Badge
                          color={statusColor.color}
                          variant={statusColor.variant}
                          data-testid={`branch-status-badge-${b.name}`}
                        >
                          {b.status}
                        </Badge>
                        {b.pullRequestNumber && (
                          <Badge color="blue" variant="light">
                            PR #{b.pullRequestNumber}
                          </Badge>
                        )}
                        {b.commentCount !== undefined && b.commentCount > 0 && (
                          <Badge color="grape" variant="light">
                            {b.commentCount} {b.commentCount === 1 ? 'comment' : 'comments'}
                          </Badge>
                        )}
                      </Group>
                      <Group gap="xs" align="center">
                        {b.updatedAt && (
                          <Text size="xs" c="dimmed">
                            Updated {b.updatedAt}
                          </Text>
                        )}
                        {b.createdBy && (
                          <>
                            <Text size="xs" c="dimmed">
                              •
                            </Text>
                            <Text size="xs" c="dimmed">
                              Owner:
                            </Text>
                            {onGetUserMetadata ? (
                              <UserBadge
                                userId={b.createdBy}
                                getUserMetadata={onGetUserMetadata}
                                variant="avatar-name"
                                size="xs"
                                showEmailTooltip={true}
                                showBadge={true}
                                badgeVariant="light"
                                color="gray"
                              />
                            ) : (
                              <Text size="xs" c="dimmed">
                                {b.createdBy}
                              </Text>
                            )}
                          </>
                        )}
                        {b.pullRequestUrl && (
                          <>
                            <Text size="xs" c="dimmed">
                              •
                            </Text>
                            <Text
                              size="xs"
                              c="blue"
                              component="a"
                              href={b.pullRequestUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ textDecoration: 'underline', cursor: 'pointer' }}
                            >
                              View PR
                            </Text>
                          </>
                        )}
                      </Group>
                      {b.access && (
                        <Group gap={6}>
                          {b.access.users?.map((u) =>
                            onGetUserMetadata ? (
                              <UserBadge
                                key={u}
                                userId={u}
                                getUserMetadata={onGetUserMetadata}
                                variant="avatar-only"
                                size="xs"
                                showEmailTooltip={true}
                              />
                            ) : (
                              <Badge key={u} variant="outline" color="neutral">
                                {u}
                              </Badge>
                            ),
                          )}
                          {b.access.groups?.map((g) => (
                            <Badge key={g} variant="outline" color="neutral">
                              {g}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Stack>
                    <Group gap={8}>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => onSelect?.(b.name)}
                        data-testid={`switch-to-branch-button-${b.name}`}
                      >
                        Open
                      </Button>
                      {b.status === 'submitted' ? (
                        <Tooltip
                          label="Only the branch creator can withdraw"
                          disabled={perms.canWithdraw}
                        >
                          <Button
                            size="xs"
                            variant="light"
                            color="orange"
                            onClick={() => onWithdraw?.(b.name)}
                            disabled={!perms.canWithdraw}
                            data-testid={`withdraw-branch-button-${b.name}`}
                          >
                            Withdraw
                          </Button>
                        </Tooltip>
                      ) : (
                        <Tooltip
                          label="Only the branch creator can submit"
                          disabled={perms.canSubmit}
                        >
                          <Button
                            size="xs"
                            variant="light"
                            color="green"
                            onClick={() => onSubmit?.(b.name)}
                            disabled={!perms.canSubmit}
                            data-testid={`submit-branch-button-${b.name}`}
                          >
                            Submit
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip
                        label="Only Reviewers or Admins can request changes"
                        disabled={perms.canRequestChanges}
                      >
                        <Button
                          size="xs"
                          variant="outline"
                          color="neutral"
                          onClick={() => onRequestChanges?.(b.name)}
                          disabled={!perms.canRequestChanges}
                          data-testid={`request-changes-button-${b.name}`}
                        >
                          Request changes
                        </Button>
                      </Tooltip>
                      <Tooltip
                        label={
                          b.status === 'submitted'
                            ? 'Cannot delete branch with open PR'
                            : 'Only Admin or branch creator can delete'
                        }
                        disabled={perms.canDelete}
                      >
                        <Button
                          size="xs"
                          variant="outline"
                          color="red"
                          onClick={() => onDelete?.(b.name)}
                          disabled={!perms.canDelete}
                          data-testid={`delete-branch-button-${b.name}`}
                        >
                          Delete
                        </Button>
                      </Tooltip>
                    </Group>
                  </Group>
                </Paper>
              )
            })}
          </Stack>
        )}
      </ScrollArea>
    </Stack>
  )
}
