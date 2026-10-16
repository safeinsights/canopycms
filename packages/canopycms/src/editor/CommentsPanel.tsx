'use client'

import React, { useId, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Switch,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core'
import type { CommentThread } from '../comment-store'
import type { UserSearchResult } from '../auth/types'
import { IconChevronRight } from '@tabler/icons-react'
import { UserBadge } from './components/UserBadge'
import { userIdLabel } from './user-display'
import { OverlayDrawer } from './shell/OverlayHeader'
import { RelativeTime } from './components/RelativeTime'
import { ThreadReplyControls } from './comments/ThreadReplyControls'
import { useTrackedWrites } from './comments/use-tracked-writes'
import { CloseRefusedNotice } from './comments/CloseRefusedNotice'
import { ON_REMOVED_ITEM } from './comments/item-anchor-copy'
import {
  CommentWriteAlert,
  toCommentWriteFailure,
  type CommentWriteFailure,
} from './comments/CommentWriteAlert'

export interface CommentsPanelProps {
  /**
   * Whether the drawer is open. The panel stays mounted while closed, so the composer text and
   * reply drafts survive a close; key it by branch to reset them for another one. It refuses to
   * close while a write is in flight, since the drawer unmounts its contents on close, and each
   * thread's busy state and error with them.
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
  /** A field thread's breadcrumb for its heading; without an answer the heading shows its path. */
  fieldLabel?: (thread: CommentThread) => string | undefined
}

const THREAD_KIND_LABELS = { field: 'Field', entry: 'Entry', branch: 'Branch' } as const

interface JumpTarget {
  label: string
  go: () => void
}

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
  const [error, setError] = useState<CommentWriteFailure | null>(null)
  const { inFlight, track, holdOpen, closeRefused } = useTrackedWrites()
  const addComment = track(onAddComment)
  const resolveThread = track(onResolveThread)
  const close = () => {
    if (!holdOpen()) onClose()
  }
  // A jump hands focus to its target (the field's or entry's comment popover, or the branches
  // drawer), so the drawer returns none: its return would land after the target took focus.
  const [jumping, setJumping] = useState(false)
  if (opened && jumping) setJumping(false)
  const jump = (go: () => void) => {
    setJumping(true)
    go()
    onClose()
  }
  // A resolved thread's card leaves the list with the focused button, so focus lands here.
  const threadCountRef = useRef<HTMLParagraphElement>(null)
  // With resolved threads shown, the card stays and its heading takes the focus instead.
  const headingRefs = useRef(new Map<string, HTMLElement>())
  const idPrefix = useId()
  const headingId = (threadId: string) => `${idPrefix}-heading-${threadId}`

  const filteredThreads = showResolved ? comments : comments.filter((t) => !t.resolved)

  const handleAddComment = async () => {
    if (!newCommentText.trim()) return

    setIsSubmitting(true)
    setError(null)
    try {
      await addComment(newCommentText, 'branch', undefined, undefined, undefined)
      setNewCommentText('')
    } catch (err) {
      setError(toCommentWriteFailure(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  // "Entry › Field", or undefined for a thread on the branch itself.
  const threadPath = (thread: CommentThread): string | undefined => {
    if (!thread.entryPath) return undefined
    const entry = entryLabel?.(thread.entryPath) ?? thread.entryPath
    const field = thread.canopyPath ? (fieldLabel?.(thread) ?? thread.canopyPath) : undefined
    return field ? `${entry} › ${field}` : entry
  }

  const threadHeading = (thread: CommentThread): string => {
    const kind = THREAD_KIND_LABELS[thread.type]
    const path = threadPath(thread)
    return path ? `${kind} · ${path}` : kind
  }

  const jumpTarget = (thread: CommentThread): JumpTarget | null => {
    const { entryPath, canopyPath } = thread
    if (
      thread.type === 'field' &&
      entryPath &&
      canopyPath &&
      !thread.onRemovedItem &&
      onJumpToField
    ) {
      return { label: 'Jump to field', go: () => onJumpToField(entryPath, canopyPath, thread.id) }
    }
    // A removed item's thread lives on its entry.
    if ((thread.type === 'entry' || thread.onRemovedItem) && entryPath && onJumpToEntry) {
      return { label: 'Jump to entry', go: () => onJumpToEntry(entryPath, thread.id) }
    }
    if (thread.type === 'branch' && onJumpToBranch) {
      return { label: 'Open branch discussion', go: () => onJumpToBranch(thread.id) }
    }
    return null
  }

  const setHeadingRef = (threadId: string, node: HTMLElement | null) => {
    if (node) headingRefs.current.set(threadId, node)
    else headingRefs.current.delete(threadId)
  }

  // The heading's text names the article; the removed-item badge beside it is outside it.
  const headingText = (thread: CommentThread) => (
    <span id={headingId(thread.id)} data-testid="comment-thread-heading">
      {threadHeading(thread)}
      {thread.onRemovedItem && <VisuallyHidden>, {ON_REMOVED_ITEM.toLowerCase()}</VisuallyHidden>}
    </span>
  )

  return (
    <OverlayDrawer
      opened={opened}
      onClose={close}
      returnFocus={!jumping}
      position="right"
      size={420}
      title="Comments"
    >
      <Stack gap="md" h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
        <Text size="xs" c="dimmed">
          Select a comment&apos;s heading to see it where it was left.
        </Text>
        <CloseRefusedNotice refused={closeRefused} />
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
            {error && <CommentWriteAlert failure={error} onClose={() => setError(null)} />}

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
              {filteredThreads.map((thread) => {
                const target = jumpTarget(thread)
                return (
                  <Paper
                    key={thread.id}
                    withBorder
                    p="md"
                    component="article"
                    aria-labelledby={headingId(thread.id)}
                    bg={thread.resolved ? 'var(--mantine-color-default-hover)' : undefined}
                    data-testid="comment-thread"
                  >
                    <Stack gap="xs">
                      <Group gap="xs">
                        {target ? (
                          // The heading is the jump control, the one tab stop on the card. It
                          // stays focusable while a write is in flight (`aria-disabled`, not
                          // `disabled`), so its reason opens on keyboard focus and touch as well
                          // as hover.
                          <Tooltip
                            label="Your change is still saving. Try again once it finishes."
                            disabled={inFlight === 0}
                            multiline
                            maw={280}
                          >
                            <Button
                              ref={(node: HTMLButtonElement | null) =>
                                setHeadingRef(thread.id, node)
                              }
                              variant="subtle"
                              color="neutral"
                              h="auto"
                              px={6}
                              py={2}
                              mx={-6}
                              rightSection={<IconChevronRight size={14} aria-hidden />}
                              aria-label={
                                threadPath(thread)
                                  ? `${target.label}: ${threadPath(thread)}`
                                  : target.label
                              }
                              aria-disabled={inFlight > 0 ? true : undefined}
                              data-disabled={inFlight > 0 ? true : undefined}
                              styles={{
                                root: { cursor: inFlight > 0 ? 'default' : 'pointer' },
                                label: { whiteSpace: 'normal', textAlign: 'start' },
                              }}
                              onClick={() => {
                                if (inFlight === 0) jump(target.go)
                              }}
                            >
                              {headingText(thread)}
                            </Button>
                          </Tooltip>
                        ) : (
                          <Text
                            ref={(node: HTMLParagraphElement | null) =>
                              setHeadingRef(thread.id, node)
                            }
                            size="xs"
                            fw={600}
                            tabIndex={-1}
                          >
                            {headingText(thread)}
                          </Text>
                        )}
                        {thread.resolved && (
                          <Badge size="xs" color="green" variant="light">
                            Resolved
                          </Badge>
                        )}
                        {thread.onRemovedItem && (
                          <Badge
                            size="xs"
                            color="gray"
                            variant="light"
                            c="var(--mantine-color-text)"
                          >
                            {ON_REMOVED_ITEM}
                          </Badge>
                        )}
                      </Group>

                      {thread.comments.map((comment, idx) => (
                        <div key={comment.id}>
                          {idx > 0 && (
                            <div
                              style={{
                                borderTop: '1px solid var(--mantine-color-default-border)',
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
                            addComment(
                              text,
                              thread.type,
                              thread.entryPath,
                              thread.canopyPath,
                              thread.id,
                            )
                          }
                          onResolve={() => resolveThread(thread.id)}
                          focusAfterResolve={() =>
                            showResolved
                              ? headingRefs.current.get(thread.id)
                              : threadCountRef.current
                          }
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
                )
              })}
            </Stack>
          )}
        </ScrollArea>
      </Stack>
    </OverlayDrawer>
  )
}
