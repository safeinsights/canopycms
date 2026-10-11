'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconMessage, IconMessagePlus, IconPlus } from '@tabler/icons-react'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { getErrorMessage } from '../../utils/error'
import { InlineCommentThread } from './InlineCommentThread'

export interface CommentThreadsPopoverProps {
  /** The threads on this field or entry. */
  threads: CommentThread[]
  /** What the comments are about, as a reader names it: a field's label, or "this entry". */
  subject: string
  /**
   * `field`: an icon that shows while `revealed`, and a count badge whenever a thread is open.
   * `entry`: a labelled "Comment on this entry" button that is always shown.
   */
  variant: 'field' | 'entry'
  /** For `field`: the pointer or focus is on the field, so the idle icon shows. */
  revealed?: boolean
  currentUserId: string
  canResolve: boolean
  /** Starts a thread, or replies to `threadId`. */
  onAddComment: (text: string, threadId?: string) => Promise<void>
  onResolveThread: (threadId: string) => Promise<void>
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** A thread here with this id opens the popover and is highlighted in it. */
  highlightThreadId?: string
  testId: string
}

const HIGHLIGHT_MS = 2000

const sortThreads = (threads: CommentThread[]): CommentThread[] =>
  [...threads].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })

const openThreadsLabel = (count: number): string =>
  count === 1 ? '1 open thread' : `${count} open threads`

/**
 * A field's or entry's comment control and the popover it opens: the threads (open first), each
 * with reply and Resolve, and a box for a new thread. Comments stay open on a read-only form,
 * since reviewers comment on submitted branches.
 */
export const CommentThreadsPopover: React.FC<CommentThreadsPopoverProps> = ({
  threads,
  subject,
  variant,
  revealed = false,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  onGetUserMetadata,
  highlightThreadId,
  testId,
}) => {
  const [opened, setOpened] = useState(false)
  const [composing, setComposing] = useState(false)
  const [flashThreadId, setFlashThreadId] = useState<string | undefined>(undefined)
  const threadRefs = useRef(new Map<string, HTMLDivElement>())
  // Touch screens have no hover, so the field icon stays visible there.
  const noHover = useMediaQuery('(hover: none)')

  const sortedThreads = useMemo(() => sortThreads(threads), [threads])
  const openCount = useMemo(() => threads.filter((t) => !t.resolved).length, [threads])

  // A newly highlighted thread here opens the popover on it; adjusted during render, not in an
  // effect, so the popover opens in the same commit.
  const [seenHighlight, setSeenHighlight] = useState<string | undefined>(undefined)
  if (highlightThreadId !== seenHighlight) {
    setSeenHighlight(highlightThreadId)
    if (highlightThreadId && threads.some((t) => t.id === highlightThreadId)) {
      setOpened(true)
      setFlashThreadId(highlightThreadId)
    }
  }

  useEffect(() => {
    if (!flashThreadId) return
    const frame = window.requestAnimationFrame(() => {
      threadRefs.current.get(flashThreadId)?.scrollIntoView({ block: 'nearest' })
    })
    const timer = window.setTimeout(() => setFlashThreadId(undefined), HIGHLIGHT_MS)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [flashThreadId])

  const close = () => {
    setOpened(false)
    setComposing(false)
  }

  const controlLabel =
    openCount > 0
      ? `Comment on ${subject} (${openThreadsLabel(openCount)})`
      : `Comment on ${subject}`

  const target =
    variant === 'entry' ? (
      <Button
        variant="subtle"
        color="gray"
        size="compact-sm"
        leftSection={<IconMessage size={16} aria-hidden />}
        rightSection={
          openCount > 0 ? (
            <Badge size="sm" variant="filled" color="orange" aria-hidden>
              {openCount}
            </Badge>
          ) : undefined
        }
        aria-label={controlLabel}
        aria-expanded={opened}
        aria-haspopup="dialog"
        onClick={() => (opened ? close() : setOpened(true))}
        data-testid={testId}
      >
        Comment on this entry
      </Button>
    ) : openCount > 0 ? (
      <Button
        variant="light"
        color="orange"
        size="compact-xs"
        leftSection={<IconMessage size={14} aria-hidden />}
        aria-label={controlLabel}
        aria-expanded={opened}
        aria-haspopup="dialog"
        onClick={() => (opened ? close() : setOpened(true))}
        data-testid={testId}
        data-comment-control
      >
        {openCount}
      </Button>
    ) : (
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={controlLabel}
        aria-expanded={opened}
        aria-haspopup="dialog"
        onClick={() => (opened ? close() : setOpened(true))}
        data-testid={testId}
        data-comment-control
        data-revealed={revealed || opened || noHover ? '' : undefined}
        style={{
          // Hidden by opacity, not display, so it stays in the tab order and shows on focus.
          opacity: revealed || opened || noHover ? 1 : 0,
          transition: 'opacity 120ms ease',
        }}
      >
        <IconMessagePlus size={16} aria-hidden />
      </ActionIcon>
    )

  return (
    <Popover
      opened={opened}
      onChange={(next) => (next ? setOpened(true) : close())}
      onClose={close}
      position="bottom-start"
      width={380}
      shadow="md"
      withArrow
      trapFocus
      returnFocus
      closeOnEscape
    >
      <Popover.Target>
        {variant === 'entry' ? (
          target
        ) : (
          <Tooltip label={controlLabel} withinPortal disabled={opened}>
            {target}
          </Tooltip>
        )}
      </Popover.Target>
      <Popover.Dropdown
        aria-label={`Comments on ${subject}`}
        data-testid={`${testId}-popover`}
        p="sm"
      >
        <Stack gap="sm">
          {/* With threads to read, opening focuses the heading rather than a reply box. */}
          <Text
            size="sm"
            fw={600}
            tabIndex={-1}
            data-autofocus={sortedThreads.length > 0 || undefined}
          >
            Comments on {subject}
          </Text>
          {sortedThreads.length > 0 && (
            <ScrollArea.Autosize mah={360} offsetScrollbars type="auto">
              <Stack gap="sm">
                {sortedThreads.map((thread) => (
                  <div
                    key={thread.id}
                    ref={(el) => {
                      if (el) threadRefs.current.set(thread.id, el)
                      else threadRefs.current.delete(thread.id)
                    }}
                    data-highlighted={flashThreadId === thread.id ? '' : undefined}
                    style={{
                      borderRadius: 4,
                      outline:
                        flashThreadId === thread.id
                          ? '2px solid var(--mantine-color-blue-5)'
                          : undefined,
                      outlineOffset: 2,
                    }}
                  >
                    <InlineCommentThread
                      thread={thread}
                      onAddReply={(text) => onAddComment(text, thread.id)}
                      onResolve={() => onResolveThread(thread.id)}
                      currentUserId={currentUserId}
                      canResolve={canResolve}
                      onGetUserMetadata={onGetUserMetadata}
                    />
                  </div>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
          {sortedThreads.length === 0 || composing ? (
            <NewThreadComposer
              onSubmit={async (text) => {
                await onAddComment(text)
                setComposing(false)
              }}
              onCancel={sortedThreads.length > 0 ? () => setComposing(false) : close}
            />
          ) : (
            <Group>
              <Button
                variant="subtle"
                size="compact-sm"
                leftSection={<IconPlus size={14} aria-hidden />}
                onClick={() => setComposing(true)}
                data-testid="new-thread-button"
              >
                New thread
              </Button>
            </Group>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

const NewThreadComposer: React.FC<{
  onSubmit: (text: string) => Promise<void>
  onCancel: () => void
}> = ({ onSubmit, onCancel }) => {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  // Shown on request ("New thread"), so it takes focus; on opening, the focus trap's
  // `data-autofocus` does the same.
  useEffect(() => {
    boxRef.current?.focus()
  }, [])

  const submit = async () => {
    if (!text.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(text)
      setText('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Stack gap="xs">
      <Textarea
        ref={boxRef}
        aria-label="New comment"
        placeholder="Add a comment…"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        minRows={2}
        autosize
        disabled={submitting}
        error={error ?? undefined}
        data-autofocus
        data-testid="new-thread-textarea"
      />
      <Group gap="xs">
        <Button
          size="compact-sm"
          onClick={() => void submit()}
          loading={submitting}
          disabled={!text.trim()}
          data-testid="create-thread-button"
        >
          Comment
        </Button>
        <Button size="compact-sm" variant="subtle" color="gray" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
  )
}
