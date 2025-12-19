'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
  Badge,
  Button,
  CloseButton,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core'
import type { CommentThread } from '../../comment-store'

export interface CommentThreadPanelProps {
  /** Threads to display (filtered for current field/entry/branch) */
  threads: CommentThread[]
  /** Type of context (determines header text) */
  contextType: 'field' | 'entry' | 'branch'
  /** Context label (e.g., "title" for field, "posts/hello" for entry) */
  contextLabel: string
  /** Whether user can resolve threads */
  canResolve: boolean
  /** User ID for permission checking */
  currentUserId: string
  /** Handler to add a comment */
  onAddComment: (text: string, threadId?: string) => Promise<void>
  /** Handler to resolve a thread */
  onResolveThread: (threadId: string) => Promise<void>
  /** Handler to close the panel */
  onClose: () => void
}

/**
 * Right-side panel showing comment threads for the active field/entry/branch.
 * Appears next to the form (pushes form left), sticky positioning while scrolling.
 */
export const CommentThreadPanel: React.FC<CommentThreadPanelProps> = ({
  threads,
  contextType,
  contextLabel,
  canResolve,
  currentUserId,
  onAddComment,
  onResolveThread,
  onClose,
}) => {
  const [newCommentText, setNewCommentText] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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

  const canUserResolve = (thread: CommentThread) => {
    if (!canResolve) return false
    // Thread author, or user with resolver permission
    return thread.authorId === currentUserId || canResolve
  }

  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp)
      return date.toLocaleString()
    } catch {
      return timestamp
    }
  }

  const getContextTypeLabel = () => {
    switch (contextType) {
      case 'field':
        return 'Field'
      case 'entry':
        return 'Entry'
      case 'branch':
        return 'Branch'
    }
  }

  const unresolvedThreads = threads.filter((t) => !t.resolved)

  return (
    <Paper
      shadow="md"
      p="md"
      style={{
        width: 360,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
      }}
    >
      <Stack gap="md" h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs">
              <Title order={5}>Comments</Title>
              <Badge size="xs" variant="light">
                {getContextTypeLabel()}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed" mt={4}>
              {contextLabel}
            </Text>
          </div>
          <CloseButton onClick={onClose} />
        </Group>

        {/* Add new comment */}
        <Paper withBorder p="sm">
          <Stack gap="xs">
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
              ref={inputRef}
              placeholder={replyTo ? 'Write a reply...' : 'Write a comment...'}
              value={newCommentText}
              onChange={(e) => setNewCommentText(e.target.value)}
              minRows={2}
              disabled={isSubmitting}
            />
            <Button onClick={handleAddComment} size="xs" loading={isSubmitting} disabled={!newCommentText.trim()}>
              {replyTo ? 'Reply' : 'Add Comment'}
            </Button>
          </Stack>
        </Paper>

        {/* Thread count */}
        <Text size="sm" fw={500}>
          {unresolvedThreads.length} unresolved {unresolvedThreads.length === 1 ? 'thread' : 'threads'}
        </Text>

        {/* Comment threads */}
        <ScrollArea style={{ flex: 1 }}>
          {threads.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="xl">
              No comments yet
            </Text>
          ) : (
            <Stack gap="md">
              {threads.map((thread) => (
                <Paper key={thread.id} withBorder p="sm" bg={thread.resolved ? 'gray.0' : undefined}>
                  <Stack gap="xs">
                    <Group justify="space-between" align="flex-start">
                      <Group gap="xs">
                        {thread.resolved && (
                          <Badge size="xs" color="green" variant="light">
                            Resolved
                          </Badge>
                        )}
                      </Group>
                      {canUserResolve(thread) && !thread.resolved && (
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
                        {idx > 0 && <div style={{ borderTop: '1px solid var(--mantine-color-gray-3)', marginTop: 8, marginBottom: 8 }} />}
                        <Stack gap={4}>
                          <Group gap="xs">
                            <Text size="xs" fw={500}>
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

                    {!thread.resolved && (
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => {
                          setReplyTo(thread.id)
                          setNewCommentText('')
                          inputRef.current?.focus()
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
    </Paper>
  )
}
