'use client'

import React, { useState } from 'react'
import {
  Badge,
  Button,
  Drawer,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Title,
  Switch,
} from '@mantine/core'
import type { CommentThread } from '../comment-store'

export interface CommentsPanelProps {
  branchName: string
  comments: CommentThread[]
  canResolve: boolean
  onAddComment: (text: string, threadId?: string) => Promise<void>
  onResolveThread: (threadId: string) => Promise<void>
  onClose: () => void
}

export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  branchName,
  comments,
  canResolve,
  onAddComment,
  onResolveThread,
  onClose,
}) => {
  const [newCommentText, setNewCommentText] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const filteredThreads = showResolved ? comments : comments.filter((t) => !t.resolved)

  const handleAddComment = async () => {
    if (!newCommentText.trim()) return

    setIsSubmitting(true)
    try {
      await onAddComment(newCommentText, replyTo || undefined)
      setNewCommentText('')
      setReplyTo(null)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResolve = async (threadId: string) => {
    setIsSubmitting(true)
    try {
      await onResolveThread(threadId)
    } finally {
      setIsSubmitting(false)
    }
  }

  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp)
      return date.toLocaleString()
    } catch {
      return timestamp
    }
  }

  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size={420}
      title={
        <div>
          <Title order={4}>Comments</Title>
          <Text size="xs" c="dimmed">
            {branchName}
          </Text>
        </div>
      }
    >
      <Stack gap="md" h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Add new comment */}
        <Paper withBorder p="md">
          <Stack gap="sm">
            {replyTo && (
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  Replying to thread
                </Text>
                <Button size="xs" variant="subtle" onClick={() => setReplyTo(null)}>
                  Cancel
                </Button>
              </Group>
            )}
            <Textarea
              placeholder={replyTo ? 'Write a reply...' : 'Write a comment...'}
              value={newCommentText}
              onChange={(e) => setNewCommentText(e.target.value)}
              minRows={3}
              disabled={isSubmitting}
            />
            <Button
              onClick={handleAddComment}
              size="sm"
              loading={isSubmitting}
              disabled={!newCommentText.trim()}
            >
              {replyTo ? 'Reply' : 'Add Comment'}
            </Button>
          </Stack>
        </Paper>

        {/* Filter toggle */}
        <Group justify="space-between">
          <Text size="sm" fw={500}>
            {filteredThreads.length} {filteredThreads.length === 1 ? 'thread' : 'threads'}
          </Text>
          <Switch
            label="Show resolved"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.currentTarget.checked)}
            size="sm"
          />
        </Group>

        {/* Comment threads */}
        <ScrollArea style={{ flex: 1 }}>
          {filteredThreads.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="xl">
              {showResolved ? 'No comments yet' : 'No unresolved comments'}
            </Text>
          ) : (
            <Stack gap="md">
              {filteredThreads.map((thread) => (
                <Paper
                  key={thread.id}
                  withBorder
                  p="md"
                  bg={thread.resolved ? 'gray.0' : undefined}
                >
                  <Stack gap="xs">
                    <Group justify="space-between" align="flex-start">
                      <Group gap="xs">
                        {thread.filePath && (
                          <Badge size="xs" variant="outline">
                            {thread.filePath}
                            {thread.lineRange && `:${thread.lineRange.start}`}
                          </Badge>
                        )}
                        {thread.resolved && (
                          <Badge size="xs" color="green" variant="light">
                            Resolved
                          </Badge>
                        )}
                      </Group>
                      {canResolve && !thread.resolved && (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="green"
                          onClick={() => handleResolve(thread.id)}
                          loading={isSubmitting}
                        >
                          Resolve
                        </Button>
                      )}
                    </Group>

                    {thread.comments.map((comment, idx) => (
                      <div key={comment.id}>
                        {idx > 0 && (
                          <div
                            style={{
                              borderTop: '1px solid var(--mantine-color-gray-3)',
                              margin: '8px 0',
                            }}
                          />
                        )}
                        <Stack gap={4}>
                          <Group gap="xs">
                            <Text size="xs" fw={500}>
                              {comment.userId}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {formatTimestamp(comment.timestamp)}
                            </Text>
                            {comment.type === 'review' && (
                              <Badge size="xs" variant="dot">
                                Review
                              </Badge>
                            )}
                          </Group>
                          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                            {comment.text}
                          </Text>
                        </Stack>
                      </div>
                    ))}

                    {!thread.resolved && (
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => {
                          setReplyTo(thread.id)
                          setNewCommentText('')
                        }}
                        mt="xs"
                      >
                        Reply
                      </Button>
                    )}
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </ScrollArea>
      </Stack>
    </Drawer>
  )
}
