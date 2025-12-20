'use client'

import React, { useState } from 'react'
import { Alert, Badge, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import type { CommentThread } from '../../comment-store'

export interface InlineCommentThreadProps {
  /** The thread to display */
  thread: CommentThread
  /** Handler to add a reply to this thread */
  onAddReply: (text: string) => Promise<void>
  /** Handler to resolve this thread */
  onResolve: () => Promise<void>
  /** Current user ID for permission checking */
  currentUserId: string
  /** Whether user can resolve threads */
  canResolve: boolean
}

/**
 * Individual comment thread display within the carousel.
 * Always shows full thread view with per-thread scrolling.
 */
export const InlineCommentThread: React.FC<InlineCommentThreadProps> = ({
  thread,
  onAddReply,
  onResolve,
  currentUserId,
  canResolve,
}) => {
  const [replyText, setReplyText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleReply = async () => {
    if (!replyText.trim()) return

    setIsSubmitting(true)
    setError(null)
    try {
      await onAddReply(replyText)
      setReplyText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add reply')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResolve = async () => {
    setIsSubmitting(true)
    setError(null)
    try {
      await onResolve()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve thread')
    } finally {
      setIsSubmitting(false)
    }
  }

  const canUserResolve = () => {
    if (!canResolve) return false
    // Thread author or user with resolver permission
    return thread.authorId === currentUserId || canResolve
  }

  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp)
      const now = new Date()
      const diff = now.getTime() - date.getTime()
      const days = Math.floor(diff / (1000 * 60 * 60 * 24))

      if (days === 0) {
        const hours = Math.floor(diff / (1000 * 60 * 60))
        if (hours === 0) {
          const minutes = Math.floor(diff / (1000 * 60))
          return minutes === 0 ? 'just now' : `${minutes}m ago`
        }
        return `${hours}h ago`
      }
      return `${days}d ago`
    } catch {
      return timestamp
    }
  }

  // Always show full thread view with per-thread scrolling
  return (
    <Paper
      withBorder
      p="md"
      bg="white"
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

        {/* All comments in thread */}
        <Stack gap="md">
          {thread.comments.map((comment, idx) => (
            <div key={comment.id}>
              {idx > 0 && <div style={{ borderTop: '1px solid var(--mantine-color-gray-3)', marginTop: 8, marginBottom: 8 }} />}
              <Stack gap={4}>
                <Group gap="xs" justify="space-between">
                  <Text size="xs" fw={600}>
                    {comment.userId}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatTimestamp(comment.timestamp)}
                  </Text>
                </Group>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {comment.text}
                </Text>
              </Stack>
            </div>
          ))}
        </Stack>

        {/* Error display */}
        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" onClose={() => setError(null)} withCloseButton>
            {error}
          </Alert>
        )}

        {/* Reply box (only if not resolved) */}
        {!thread.resolved && (
          <Stack gap="xs">
            <Textarea
              placeholder="Write a reply..."
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              minRows={2}
              disabled={isSubmitting}
            />
            <Group gap="xs">
              <Button
                size="xs"
                onClick={handleReply}
                loading={isSubmitting}
                disabled={!replyText.trim()}
              >
                Reply
              </Button>
              {canUserResolve() && (
                <Button
                  size="xs"
                  variant="light"
                  color="green"
                  onClick={handleResolve}
                  loading={isSubmitting}
                >
                  Resolve
                </Button>
              )}
            </Group>
          </Stack>
        )}

        {/* Resolved info */}
        {thread.resolved && thread.resolvedBy && (
          <Text size="xs" c="dimmed" fs="italic">
            Resolved by {thread.resolvedBy}
            {thread.resolvedAt && ` ${formatTimestamp(thread.resolvedAt)}`}
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
