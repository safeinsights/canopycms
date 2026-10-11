'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Alert, Button, Group, Stack, Textarea } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import type { CommentThread } from '../../comment-store'
import { getErrorMessage } from '../../utils/error'

export interface ThreadReplyControlsProps {
  /** An unresolved thread; a resolved one has nothing to reply to. */
  thread: CommentThread
  /** Adds a reply to this thread; rejecting keeps the box open with the text. */
  onAddReply: (text: string) => Promise<void>
  onResolve: () => Promise<void>
  currentUserId: string
  /** Whether the user may resolve any thread; a thread's own author always may resolve it. */
  canResolve: boolean
  /** The reply draft, when the caller keeps it, so it outlives this component; with `onReplyTextChange`. */
  replyText?: string
  onReplyTextChange?: (text: string) => void
}

/** Refocuses `box` when a submit settles: the busy button disabled itself and dropped focus. */
export const useRefocusAfterSubmit = (
  submitting: boolean,
  box: React.RefObject<HTMLTextAreaElement | null>,
): void => {
  const wasSubmitting = useRef(false)
  useEffect(() => {
    if (wasSubmitting.current && !submitting) box.current?.focus()
    wasSubmitting.current = submitting
  }, [submitting, box])
}

/**
 * A thread's Reply and Resolve controls. Reply opens the reply box in place, so a list of open
 * threads shows buttons rather than one box each; Cancel closes it and keeps the draft. Reply and
 * Resolve each show only their own progress, and the one error here belongs to this thread.
 */
export const ThreadReplyControls: React.FC<ThreadReplyControlsProps> = ({
  thread,
  onAddReply,
  onResolve,
  currentUserId,
  canResolve,
  replyText: controlledReply,
  onReplyTextChange,
}) => {
  const [ownReply, setOwnReply] = useState('')
  const replyText = controlledReply ?? ownReply
  const setReplyText = onReplyTextChange ?? setOwnReply
  const [expanded, setExpanded] = useState(replyText.length > 0)
  const [replying, setReplying] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const replyButtonRef = useRef<HTMLButtonElement>(null)
  // Where focus goes once the next expand or collapse has rendered.
  const focusNext = useRef<'box' | 'button' | null>(null)
  useRefocusAfterSubmit(replying, boxRef)

  useEffect(() => {
    if (focusNext.current === (expanded ? 'box' : 'button')) {
      ;(expanded ? boxRef : replyButtonRef).current?.focus()
      focusNext.current = null
    }
  }, [expanded])

  const expand = () => {
    focusNext.current = 'box'
    setExpanded(true)
  }

  const collapse = () => {
    focusNext.current = 'button'
    setExpanded(false)
  }

  const handleReply = async () => {
    if (!replyText.trim()) return
    setReplying(true)
    setError(null)
    try {
      await onAddReply(replyText)
      setReplyText('')
      collapse()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setReplying(false)
    }
  }

  const handleResolve = async () => {
    setResolving(true)
    setError(null)
    try {
      await onResolve()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setResolving(false)
    }
  }

  const mayResolve = canResolve || thread.authorId === currentUserId
  const resolveButton = mayResolve && (
    <Button
      variant="light"
      color="green"
      onClick={handleResolve}
      loading={resolving}
      disabled={replying}
      data-testid="resolve-thread-button"
    >
      Resolve
    </Button>
  )

  return (
    <Stack gap="xs">
      {error && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          variant="light"
          onClose={() => setError(null)}
          withCloseButton
        >
          {error}
        </Alert>
      )}
      {expanded ? (
        <>
          <Textarea
            ref={boxRef}
            placeholder="Write a reply…"
            aria-label="Reply to this thread"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            minRows={2}
            disabled={replying}
          />
          <Group gap="xs">
            <Button
              onClick={handleReply}
              loading={replying}
              disabled={!replyText.trim() || resolving}
              data-testid="submit-reply-button"
            >
              Reply
            </Button>
            <Button variant="subtle" color="gray" onClick={collapse} disabled={replying}>
              Cancel
            </Button>
            {resolveButton}
          </Group>
        </>
      ) : (
        <Group gap="xs">
          <Button
            ref={replyButtonRef}
            variant="light"
            onClick={expand}
            disabled={resolving}
            data-testid="reply-thread-button"
          >
            Reply
          </Button>
          {resolveButton}
        </Group>
      )}
    </Stack>
  )
}
