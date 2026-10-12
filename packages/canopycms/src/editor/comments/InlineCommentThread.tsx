'use client'

import React from 'react'
import { Badge, Group, Paper, Stack, Text } from '@mantine/core'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { UserBadge } from '../components/UserBadge'
import { userIdLabel } from '../user-display'
import { RelativeTime } from '../components/RelativeTime'
import { ThreadReplyControls } from './ThreadReplyControls'

export interface InlineCommentThreadProps {
  /** The thread to display */
  thread: CommentThread
  /** Handler to add a reply to this thread */
  onAddReply: (text: string) => Promise<void>
  /** Handler to resolve this thread */
  onResolve: () => Promise<void>
  /** Where focus goes after a resolve; see `ThreadReplyControls`. */
  focusAfterResolve?: () => HTMLElement | null | undefined
  /** Current user ID for permission checking */
  currentUserId: string
  /** Whether the user may resolve any thread; a thread's own author always may resolve it. */
  canResolve: boolean
  /** Optional function to fetch user metadata for displaying user badges */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** The reply draft, when the caller keeps it, so it outlives this component; with `onReplyTextChange`. */
  replyText?: string
  onReplyTextChange?: (text: string) => void
}

/**
 * One comment thread, as the comment popover and ThreadCarousel list them.
 * Always shows full thread view with per-thread scrolling.
 */
export const InlineCommentThread: React.FC<InlineCommentThreadProps> = ({
  thread,
  onAddReply,
  onResolve,
  focusAfterResolve,
  currentUserId,
  canResolve,
  onGetUserMetadata,
  replyText,
  onReplyTextChange,
}) => {
  return (
    <Paper
      withBorder
      p="md"
      bg="white"
      data-testid="inline-comment-thread"
      style={{
        width: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Stack gap="md">
        <Group gap="xs">
          {!thread.resolved && (
            <Badge size="xs" color="orange" variant="light">
              Unresolved
            </Badge>
          )}
          {thread.resolved && (
            <Badge size="xs" color="green" variant="light">
              Resolved
            </Badge>
          )}
        </Group>

        <Stack gap="md">
          {thread.comments.map((comment, idx) => (
            <div key={comment.id}>
              {idx > 0 && (
                <div
                  style={{
                    borderTop: '1px solid var(--mantine-color-default-border)',
                    marginTop: 8,
                    marginBottom: 8,
                  }}
                />
              )}
              <Stack gap={4}>
                <Group gap="xs" justify="space-between">
                  {onGetUserMetadata ? (
                    <UserBadge
                      userId={comment.userId}
                      getUserMetadata={onGetUserMetadata}
                      variant="avatar-name"
                      size="xs"
                      showEmailTooltip={true}
                      showBadge={true}
                      badgeVariant="light"
                      color="gray"
                    />
                  ) : (
                    <Text size="xs" fw={600}>
                      {userIdLabel(comment.userId)}
                    </Text>
                  )}
                  <RelativeTime iso={comment.timestamp} size="xs" c="dimmed" />
                </Group>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {comment.text}
                </Text>
              </Stack>
            </div>
          ))}
        </Stack>

        {!thread.resolved && (
          <ThreadReplyControls
            thread={thread}
            onAddReply={onAddReply}
            onResolve={onResolve}
            focusAfterResolve={focusAfterResolve}
            currentUserId={currentUserId}
            canResolve={canResolve}
            replyText={replyText}
            onReplyTextChange={onReplyTextChange}
          />
        )}

        {thread.resolved && thread.resolvedBy && (
          <Group gap={4}>
            <Text size="xs" c="dimmed" fs="italic">
              Resolved by
            </Text>
            {onGetUserMetadata ? (
              <UserBadge
                userId={thread.resolvedBy}
                getUserMetadata={onGetUserMetadata}
                variant="avatar-name"
                size="xs"
                showEmailTooltip={true}
                showBadge={true}
                badgeVariant="light"
                color="gray"
              />
            ) : (
              <Text size="xs" c="dimmed" fs="italic">
                {userIdLabel(thread.resolvedBy)}
              </Text>
            )}
            {thread.resolvedAt && (
              <RelativeTime iso={thread.resolvedAt} size="xs" c="dimmed" fs="italic" />
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  )
}
