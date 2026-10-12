'use client'

import React, { useId, useRef, useState } from 'react'
import {
  Alert,
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
import type { UserSearchResult } from '../auth/types'
import { UserBadge } from './components/UserBadge'
import { userIdLabel } from './user-display'
import { RelativeTime } from './components/RelativeTime'
import { ThreadReplyControls } from './comments/ThreadReplyControls'
import { useTrackedWrites } from './comments/use-tracked-writes'
import { getErrorMessage } from '../utils/error'

export interface CommentsPanelProps {
  /**
   * Whether the drawer is open. The panel stays mounted while closed, so the composer text and
   * reply drafts survive a close; key it by branch to reset them for another one.
   */
  opened: boolean
  branchName: string
  comments: CommentThread[]
  /** Whether the user may resolve any thread; a thread's own author always may resolve it. */
  canResolve: boolean
  /** The user the panel is for, to tell which threads they started. */
  currentUserId: string
  onAddComment: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryPath?: string,
    canopyPath?: string,
    threadId?: string,
  ) => Promise<void>
  onResolveThread: (threadId: string) => Promise<void>
  onClose: () => void
  /** Jump to field and auto-expand inline comments */
  onJumpToField?: (entryPath: string, canopyPath: string, threadId: string) => void
  /** Jump to entry comments (top of form) */
  onJumpToEntry?: (entryPath: string, threadId: string) => void
  /** Open branch manager */
  onJumpToBranch?: (threadId: string) => void
  /** Optional function to fetch user metadata for displaying user badges */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** An entry's title for a thread's heading; without an answer the heading shows its path. */
  entryLabel?: (entryPath: string) => string | undefined
  /** A field's breadcrumb for a thread's heading; without an answer the heading shows its path. */
  fieldLabel?: (entryPath: string, canopyPath: string) => string | undefined
}

const THREAD_KIND_LABELS = { field: 'Field', entry: 'Entry', branch: 'Branch' } as const

export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  opened,
  branchName,
  comments,
  canResolve,
  currentUserId,
  onAddComment,
  onResolveThread,
  onClose,
  onJumpToField,
  onJumpToEntry,
  onJumpToBranch,
  onGetUserMetadata,
  entryLabel,
  fieldLabel,
}) => {
  const [newCommentText, setNewCommentText] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [showResolved, setShowResolved] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { track } = useTrackedWrites()
  const addReply = track(onAddComment)
  const resolveThread = track(onResolveThread)
  // A resolved thread's card leaves the list with the focused button, so focus lands here.
  const threadCountRef = useRef<HTMLParagraphElement>(null)
  // With resolved threads shown, the card stays and its heading takes the focus instead.
  const headingRefs = useRef(new Map<string, HTMLParagraphElement>())
  const idPrefix = useId()
  const headingId = (threadId: string) => `${idPrefix}-heading-${threadId}`

  const filteredThreads = showResolved ? comments : comments.filter((t) => !t.resolved)

  const handleAddComment = async () => {
    if (!newCommentText.trim()) return

    setIsSubmitting(true)
    setError(null)
    try {
      await onAddComment(newCommentText, 'branch', undefined, undefined, undefined)
      setNewCommentText('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const threadHeading = (thread: CommentThread): string => {
    const kind = THREAD_KIND_LABELS[thread.type]
    if (!thread.entryPath) return kind
    const entry = entryLabel?.(thread.entryPath) ?? thread.entryPath
    const field = thread.canopyPath
      ? (fieldLabel?.(thread.entryPath, thread.canopyPath) ?? thread.canopyPath)
      : undefined
    return `${kind} · ${field ? `${entry} › ${field}` : entry}`
  }

  return (
    <Drawer
      opened={opened}
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
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Text size="xs" c="dimmed">
              Posts a branch-level comment on &quot;{branchName}&quot;. To comment on a field, use
              its comment icon.
            </Text>
            <Textarea
              placeholder="Add a comment…"
              aria-label="New branch comment"
              value={newCommentText}
              onChange={(e) => setNewCommentText(e.target.value)}
              minRows={3}
              disabled={isSubmitting}
              data-testid="comment-textarea"
            />
            {error && (
              <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
            <Button
              onClick={handleAddComment}
              size="sm"
              loading={isSubmitting}
              disabled={!newCommentText.trim()}
              data-testid="comment-submit"
            >
              Comment
            </Button>
          </Stack>
        </Paper>

        <Group justify="space-between">
          <Text ref={threadCountRef} size="sm" fw={500} tabIndex={-1}>
            {filteredThreads.length} {filteredThreads.length === 1 ? 'thread' : 'threads'}
          </Text>
          <Switch
            label="Show resolved"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.currentTarget.checked)}
            size="sm"
          />
        </Group>

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
                  component="article"
                  aria-labelledby={headingId(thread.id)}
                  bg={thread.resolved ? 'gray.0' : undefined}
                  data-testid="comment-thread"
                >
                  <Stack gap="xs">
                    <Group gap="xs">
                      <Text
                        id={headingId(thread.id)}
                        ref={(node: HTMLParagraphElement | null) => {
                          if (node) headingRefs.current.set(thread.id, node)
                          else headingRefs.current.delete(thread.id)
                        }}
                        size="xs"
                        fw={600}
                        tabIndex={-1}
                        data-testid="comment-thread-heading"
                      >
                        {threadHeading(thread)}
                      </Text>
                      {thread.resolved && (
                        <Badge size="xs" color="green" variant="light">
                          Resolved
                        </Badge>
                      )}
                    </Group>

                    <Group gap="xs">
                      {thread.type === 'field' &&
                        thread.entryPath &&
                        thread.canopyPath &&
                        onJumpToField && (
                          <Button
                            variant="light"
                            onClick={() => {
                              onJumpToField(thread.entryPath!, thread.canopyPath!, thread.id)
                              onClose()
                            }}
                          >
                            Jump to field
                          </Button>
                        )}
                      {thread.type === 'entry' && thread.entryPath && onJumpToEntry && (
                        <Button
                          variant="light"
                          onClick={() => {
                            onJumpToEntry(thread.entryPath!, thread.id)
                            onClose()
                          }}
                        >
                          Jump to entry
                        </Button>
                      )}
                      {thread.type === 'branch' && onJumpToBranch && (
                        <Button
                          variant="light"
                          onClick={() => {
                            onJumpToBranch(thread.id)
                            onClose()
                          }}
                        >
                          Open branch discussion
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
                              <Text size="xs" fw={500}>
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

                    {!thread.resolved && (
                      <ThreadReplyControls
                        thread={thread}
                        onAddReply={(text) =>
                          addReply(
                            text,
                            thread.type,
                            thread.entryPath,
                            thread.canopyPath,
                            thread.id,
                          )
                        }
                        onResolve={async () => {
                          await resolveThread(thread.id)
                          ;(showResolved
                            ? headingRefs.current.get(thread.id)
                            : threadCountRef.current
                          )?.focus()
                        }}
                        currentUserId={currentUserId}
                        canResolve={canResolve}
                        replyText={replyDrafts[thread.id] ?? ''}
                        onReplyTextChange={(text) =>
                          setReplyDrafts((prev) => ({ ...prev, [thread.id]: text }))
                        }
                      />
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
