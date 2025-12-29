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
import type { BranchMode } from '../paths'
import type { CommentThread } from '../comment-store'
import { BranchComments } from './comments/BranchComments'
import { isAdmin, isReviewer } from '../reserved-groups'

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
 * Compute what actions the current user can perform on a branch
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

  // Submit: Only creator can submit their branch
  const canSubmit = userIsCreator && branch.status === 'editing'

  // Withdraw: Only creator can withdraw their submitted branch
  const canWithdraw = userIsCreator && branch.status === 'submitted'

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
  mode?: BranchMode
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
}) => {
  const isLocalSimple = mode === 'local-simple'
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
    <Stack h="100%" style={{ display: 'flex', flexDirection: 'column' }} gap={0}>
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
          />
        </Stack>
      )}

      {!isLocalSimple && (
        <Stack gap="sm" pt="sm">
          <Button
            variant="light"
            size="sm"
            fullWidth
            onClick={() => setShowCreateForm(!showCreateForm)}
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
                />
                <TextInput
                  label="Title (optional)"
                  placeholder="Brief description"
                  value={newBranchTitle}
                  onChange={(e) => setNewBranchTitle(e.target.value)}
                />
                <Textarea
                  label="Description (optional)"
                  placeholder="Detailed description of the changes"
                  value={newBranchDescription}
                  onChange={(e) => setNewBranchDescription(e.target.value)}
                  minRows={2}
                />
                <Button onClick={handleCreate} disabled={!newBranchName.trim()} fullWidth>
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
            {isLocalSimple
              ? 'Branch management is disabled in local-simple mode.'
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
                <Paper key={b.name} withBorder radius="md" p="md" shadow="xs">
                  <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                      <Group gap="xs">
                        <Text fw={600}>{b.name}</Text>
                        <Badge color={statusColor.color} variant={statusColor.variant}>
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
                        <Text size="xs" c="dimmed">
                          {b.updatedAt ? `Updated ${b.updatedAt}` : ''}
                          {b.createdBy ? ` • Owner: ${b.createdBy}` : ''}
                        </Text>
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
                          {b.access.users?.map((u) => (
                            <Badge key={u} variant="outline" color="neutral">
                              {u}
                            </Badge>
                          ))}
                          {b.access.groups?.map((g) => (
                            <Badge key={g} variant="outline" color="neutral">
                              {g}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Stack>
                    <Group gap={8}>
                      <Button size="xs" variant="light" onClick={() => onSelect?.(b.name)}>
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
