'use client'

import React, { useEffect, useId, useRef, useState } from 'react'
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

/**
 * A jump button that stays focusable while a write is in flight (`aria-disabled`, not `disabled`),
 * so its reason opens on keyboard focus and touch as well as hover.
 */
const JumpButton: React.FC<{
  blocked: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ blocked, onClick, children }) => (
  <Tooltip
    label="Your change is still saving. Try again once it finishes."
    disabled={!blocked}
    multiline
    maw={280}
  >
    <Button
      variant="light"
      onClick={() => {
        if (!blocked) onClick()
      }}
      data-disabled={blocked ? true : undefined}
      aria-disabled={blocked ? true : undefined}
    >
      {children}
    </Button>
  </Tooltip>
)

const THREAD_KIND_LABELS = { field: 'Field', entry: 'Entry', branch: 'Branch' } as const

// A card's click jumps, except from these, which act or select on their own.
const CARD_CONTROLS =
  'a, button, input, textarea, select, label, summary, [role="button"], [contenteditable]'

/** The thread card a click landed on, unless it landed on a control or ended a text selection. */
function plainCardClick(event: MouseEvent): HTMLElement | null {
  if (event.defaultPrevented || !(event.target instanceof Element)) return null
  const card = event.target.closest<HTMLElement>('[data-thread-id]')
  if (!card) return null
  const control = event.target.closest(CARD_CONTROLS)
  if (control && card.contains(control)) return null
  return window.getSelection()?.toString() ? null : card
}

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
  const headingRefs = useRef(new Map<string, HTMLParagraphElement>())
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

  const threadHeading = (thread: CommentThread): string => {
    const kind = THREAD_KIND_LABELS[thread.type]
    if (!thread.entryPath) return kind
    const entry = entryLabel?.(thread.entryPath) ?? thread.entryPath
    const field = thread.canopyPath ? (fieldLabel?.(thread) ?? thread.canopyPath) : undefined
    return `${kind} · ${field ? `${entry} › ${field}` : entry}`
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

  // A click on a card's body is the same jump as its button. It is a listener on the list, not a
  // handler on each article: the button is the keyboard and assistive-tech route, so the article
  // stays a plain landmark and the click only adds a larger target for the pointer.
  const [list, setList] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!list) return
    const onClick = (event: MouseEvent) => {
      const card = plainCardClick(event)
      const thread = comments.find((t) => t.id === card?.dataset.threadId)
      const target = thread && jumpTarget(thread)
      if (target && inFlight === 0) jump(target.go)
    }
    list.addEventListener('click', onClick)
    return () => list.removeEventListener('click', onClick)
  })

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
          Jump opens the comment next to its field.
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
            <Stack gap="md" ref={setList}>
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
                    data-thread-id={thread.id}
                    style={target ? { cursor: 'pointer' } : undefined}
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
                          {/* The badge beside it is outside the heading, which names the article. */}
                          {thread.onRemovedItem && (
                            <VisuallyHidden>, {ON_REMOVED_ITEM.toLowerCase()}</VisuallyHidden>
                          )}
                        </Text>
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

                      {target && (
                        <Group gap="xs">
                          <JumpButton blocked={inFlight > 0} onClick={() => jump(target.go)}>
                            {target.label}
                          </JumpButton>
                        </Group>
                      )}

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
