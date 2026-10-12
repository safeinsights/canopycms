'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
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
import { useTrackedWrites } from './use-tracked-writes'
import { useRefocusAfterSubmit } from './ThreadReplyControls'

export interface CommentThreadsPopoverProps {
  /** The threads on this field or entry. */
  threads: CommentThread[]
  /** What the comments are about, as a reader names it: a field's breadcrumb, or "this entry". */
  subject: string
  /**
   * `field`: an icon that shows while `revealed` or any thread exists, as a count while one is open.
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
  // Drafts live here, not in the dropdown, which unmounts whenever the popover closes.
  const [newThreadDraft, setNewThreadDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const headingRef = useRef<HTMLParagraphElement>(null)
  const [flashThreadId, setFlashThreadId] = useState<string | undefined>(undefined)
  const threadRefs = useRef(new Map<string, HTMLDivElement>())
  // Set by a post; the "New thread" button takes focus when it next mounts, as the composer goes.
  const focusNewThreadRef = useRef(false)
  // Touch screens have no hover, so the field icon stays visible there.
  const noHover = useMediaQuery('(hover: none)')

  const sortedThreads = useMemo(() => sortThreads(threads), [threads])
  const openCount = useMemo(() => threads.filter((t) => !t.resolved).length, [threads])

  // A newly highlighted thread here opens the popover on it; adjusted during render, not in an
  // effect, so the popover opens in the same commit.
  const [seenHighlight, setSeenHighlight] = useState<string | undefined>(undefined)
  // It stays unseen until its thread arrives, so a thread list that catches up still opens it.
  const highlightHere = !!highlightThreadId && threads.some((t) => t.id === highlightThreadId)
  if (highlightThreadId !== seenHighlight && (!highlightThreadId || highlightHere)) {
    setSeenHighlight(highlightThreadId)
    if (highlightHere) {
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

  // While a post or Resolve is in flight the popover stays open, so its busy state and any error
  // stay in view and a reopened composer can't send the same text twice.
  const { inFlight, track } = useTrackedWrites()
  const addComment = track(onAddComment)
  const resolveThread = track(onResolveThread)

  const close = () => {
    if (inFlight > 0) return
    setOpened(false)
    setComposing(false)
    focusNewThreadRef.current = false
  }

  const controlLabel =
    openCount > 0
      ? `Comment on ${subject} (${openThreadsLabel(openCount)})`
      : `Comment on ${subject}`

  // Any thread keeps the control in view: a count while one is open, else a plain icon, so a
  // field's resolved history is findable.
  const shown = revealed || opened || noHover || threads.length > 0

  const target =
    variant === 'entry' ? (
      <Button
        variant="subtle"
        color="gray"
        c="gray.8"
        size="compact-sm"
        leftSection={<IconMessage size={16} aria-hidden />}
        rightSection={
          openCount > 0 ? (
            <Badge size="sm" variant="light" color="orange" c="dark.7" aria-hidden>
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
    ) : (
      // One element for every state, so the popover's anchor and returnFocus target survive a
      // count change.
      <Button
        variant={openCount > 0 ? 'light' : 'subtle'}
        color={openCount > 0 ? 'orange' : 'gray'}
        c={openCount > 0 ? 'dark.7' : undefined}
        size="compact-xs"
        px={4}
        aria-label={controlLabel}
        aria-expanded={opened}
        aria-haspopup="dialog"
        onClick={() => (opened ? close() : setOpened(true))}
        data-testid={testId}
        data-comment-control
        data-revealed={shown ? '' : undefined}
        style={{
          // Hidden by opacity, not display, so it stays in the tab order and shows on focus.
          opacity: shown ? 1 : 0,
          transition: 'opacity 120ms ease',
        }}
      >
        <Group gap={4} wrap="nowrap">
          {threads.length === 0 ? (
            <IconMessagePlus size={16} aria-hidden />
          ) : (
            <IconMessage
              size={14}
              color={openCount > 0 ? 'var(--mantine-color-orange-7)' : undefined}
              aria-hidden
            />
          )}
          {openCount > 0 && <span>{openCount}</span>}
        </Group>
      </Button>
    )

  return (
    <Popover
      opened={opened}
      onChange={(next) => (next ? setOpened(true) : close())}
      onClose={close}
      // Above the label row where there is room, so the input it is about stays in view.
      position="top-start"
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
            ref={headingRef}
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
                      outlineOffset: -2,
                    }}
                  >
                    <InlineCommentThread
                      thread={thread}
                      onAddReply={(text) => addComment(text, thread.id)}
                      onResolve={() => resolveThread(thread.id)}
                      // Resolve and the reply box go with the open state, so focus stays inside.
                      focusAfterResolve={() => headingRef.current}
                      replyText={replyDrafts[thread.id] ?? ''}
                      onReplyTextChange={(text) =>
                        setReplyDrafts((prev) => ({ ...prev, [thread.id]: text }))
                      }
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
              text={newThreadDraft}
              onTextChange={setNewThreadDraft}
              onSubmit={async (text) => {
                // Set first: the first thread's arrival mounts the button before this resolves.
                focusNewThreadRef.current = true
                try {
                  await addComment(text)
                } catch (err) {
                  focusNewThreadRef.current = false
                  throw err
                }
                setComposing(false)
              }}
              onCancel={sortedThreads.length > 0 ? () => setComposing(false) : close}
            />
          ) : (
            <Group>
              <Button
                ref={(el) => {
                  if (el && focusNewThreadRef.current) {
                    focusNewThreadRef.current = false
                    el.focus()
                  }
                }}
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
  text: string
  onTextChange: (text: string) => void
  onSubmit: (text: string) => Promise<void>
  onCancel: () => void
}> = ({ text, onTextChange: setText, onSubmit, onCancel }) => {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  // Shown on request ("New thread"), so it takes focus.
  useEffect(() => {
    boxRef.current?.focus()
  }, [])
  useRefocusAfterSubmit(submitting, boxRef)

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
        <Button
          size="compact-sm"
          variant="subtle"
          color="gray"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </Group>
    </Stack>
  )
}
