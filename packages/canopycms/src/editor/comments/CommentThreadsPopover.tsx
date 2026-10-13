'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import {
  useClickOutside,
  useDidUpdate,
  useId,
  useIsomorphicEffect,
  useMediaQuery,
  useWindowEvent,
} from '@mantine/hooks'
import { IconMessage, IconMessagePlus, IconPlus } from '@tabler/icons-react'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { getErrorMessage } from '../../utils/error'
import { InlineCommentThread } from './InlineCommentThread'
import { useTrackedWrites } from './use-tracked-writes'
import { CloseRefusedNotice } from './CloseRefusedNotice'
import { useRefocusAfterSubmit } from './ThreadReplyControls'
import { commentsAriaKeyShortcuts, commentsShortcutLabel } from './form-comments'
import { choosePopoverSide, type FieldAnchors, type PopoverSide } from './popover-placement'

export interface CommentThreadsPopoverProps {
  /** The threads on this field or entry. */
  threads: CommentThread[]
  /** What the comments are about, as a reader names it: a field's breadcrumb, or "this entry". */
  subject: string
  /**
   * `field`: an icon that shows while `revealed`, and as a count while a thread is open.
   * `entry`: a labelled "Comment on this entry" button that is always shown.
   */
  variant: 'field' | 'entry'
  /** For `field`: the pointer or focus is on the field, so the idle icon shows. */
  revealed?: boolean
  /** For `field`: where the popover may open, above the label row or below the input. */
  anchors?: FieldAnchors
  /** For `field`: each new request opens the popover, as the form's keyboard route asks. */
  openRequest?: OpenRequest
  currentUserId: string
  canResolve: boolean
  /** Starts a thread, or replies to `threadId`. */
  onAddComment: (text: string, threadId?: string) => Promise<void>
  onResolveThread: (threadId: string) => Promise<void>
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** A thread here with this id opens the popover and is highlighted in it. */
  highlightThreadId?: string
  /** Names the field of a thread shown away from it, such as one on a removed item. */
  threadFieldLabel?: (thread: CommentThread) => string | undefined
  /**
   * Why a new thread can't be posted here yet, such as a field of an item only the draft has.
   * Shown before anyone types; the box stays usable, so a draft survives until it can be posted.
   */
  composeBlockedReason?: string
  testId: string
}

export interface OpenRequest {
  /** Takes focus in place of the opener, such as a menu item gone by close, unless a click closes the popover. */
  returnFocusTo?: () => HTMLElement | null
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
  anchors,
  openRequest,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  onGetUserMetadata,
  highlightThreadId,
  threadFieldLabel,
  composeBlockedReason,
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
  const popoverId = useId()
  const [controlNode, setControlNode] = useState<HTMLButtonElement | null>(null)
  // Read when focus returns: a popover that mounts open has no `controlNode` state as it opens.
  const controlRef = useRef<HTMLButtonElement | null>(null)
  const setControl = useCallback((el: HTMLButtonElement | null) => {
    controlRef.current = el
    setControlNode(el)
  }, [])
  const [dropdownNode, setDropdownNode] = useState<HTMLDivElement | null>(null)
  // Set by a menu item's open, whose item is gone by close: its menu's trigger stands in.
  const [returnFocusTo, setReturnFocusTo] = useState<OpenRequest['returnFocusTo']>(undefined)
  // Where focus returns on close, recorded as the popover opens, before its focus trap runs.
  const openerRef = useRef<{ target: () => HTMLElement | null; standIn: boolean } | null>(null)
  const [side, setSide] = useState<PopoverSide>('below')
  // A highlight's open always scrolls its field into place, even when it fits, and so overrides
  // the smooth scroll `handleJumpToField` (`hooks/useCommentSystem.ts`) starts.
  const [scrollOnOpen, setScrollOnOpen] = useState(false)
  const placedRef = useRef(false)
  // A click chose where focus goes, so a stand-in never takes it.
  const pointerClosedRef = useRef(false)
  const open = ({ scroll = false }: { scroll?: boolean } = {}) => {
    setReturnFocusTo(undefined)
    setScrollOnOpen(scroll)
    setOpened(true)
  }

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
      open({ scroll: true })
      setFlashThreadId(highlightThreadId)
    }
  }

  const [seenOpenRequest, setSeenOpenRequest] = useState(openRequest)
  if (openRequest !== seenOpenRequest) {
    setSeenOpenRequest(openRequest)
    if (openRequest) {
      setOpened(true)
      setScrollOnOpen(false)
      setReturnFocusTo(() => openRequest.returnFocusTo)
    }
  }

  // Once per open, before paint, as soon as both anchors exist: a field that mounts already
  // highlighted gets them a commit after the popover opens.
  useIsomorphicEffect(() => {
    if (!opened) {
      placedRef.current = false
      return
    }
    if (placedRef.current || !anchors?.above || !anchors.below) return
    placedRef.current = true
    setSide(choosePopoverSide(anchors, { scroll: scrollOnOpen }))
  }, [opened, anchors])

  useIsomorphicEffect(() => {
    if (!opened) return
    pointerClosedRef.current = false
    const active = document.activeElement
    openerRef.current = returnFocusTo
      ? { target: returnFocusTo, standIn: true }
      : {
          // A popover that opened with nothing focused, as on a highlight, returns to its control.
          target: () =>
            active instanceof HTMLElement && active !== document.body && active.isConnected
              ? active
              : controlRef.current,
          standIn: false,
        }
  }, [opened])

  // Focus returns here rather than through Mantine, which refocuses the opener even after a click
  // has put focus on another control.
  useDidUpdate(() => {
    const opener = openerRef.current
    if (opened || !opener) return
    if (pointerClosedRef.current && opener.standIn) return
    const closing = dropdownNode
    const timer = window.setTimeout(() => {
      const active = document.activeElement
      // Focus left in the fading dropdown, on a detached or closing menu item, or nowhere, hasn't
      // been moved on by the user.
      const unmoved =
        !active ||
        active === document.body ||
        !active.isConnected ||
        closing?.contains(active) ||
        active.closest('[data-menu-dropdown]')
      if (!unmoved) return
      const target = opener.target()
      target?.focus({ preventScroll: true })
      if (opener.standIn) target?.scrollIntoView?.({ block: 'nearest' })
    }, 20)
    return () => window.clearTimeout(timer)
  }, [opened])

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
  const { inFlight, track, holdOpen, closeRefused } = useTrackedWrites()
  const addComment = track(onAddComment)
  const resolveThread = track(onResolveThread)

  const close = () => {
    if (holdOpen()) return
    setOpened(false)
    setComposing(false)
    focusNewThreadRef.current = false
  }

  const controlLabel =
    openCount > 0
      ? `Comment on ${subject} (${openThreadsLabel(openCount)})`
      : `Comment on ${subject}`

  // Open threads keep the control in view as a count; resolved ones are listed by the form's
  // "Field comments" menu.
  const shown = revealed || opened || noHover || openCount > 0
  // Idle, the control leaves the tab order: the form's menu and shortcut reach comments instead.
  const idle = !opened && openCount === 0
  const anchored = variant === 'field' && anchors !== undefined
  const controlTooltip =
    openCount > 0
      ? `Comment on ${subject} (${openThreadsLabel(openCount)}, ${commentsShortcutLabel()})`
      : `Comment on ${subject} (${commentsShortcutLabel()})`

  // Mantine's Escape is off in flight; on the window, as a disabled composer drops focus.
  useWindowEvent('keydown', (event) => {
    if (event.key === 'Escape' && opened) holdOpen()
  })

  const closeByPointer = () => {
    if (holdOpen()) return
    pointerClosedRef.current = true
    close()
  }
  // Anchored, the control is outside the popover's target, so clicks on it count as inside here.
  useClickOutside(() => anchored && opened && closeByPointer(), null, [controlNode, dropdownNode])

  const target =
    variant === 'entry' ? (
      <Button
        variant="subtle"
        color="gray"
        c="var(--mantine-color-text)"
        size="compact-sm"
        leftSection={<IconMessage size={16} aria-hidden />}
        rightSection={
          openCount > 0 ? (
            <Badge
              size="sm"
              variant="light"
              color="orange"
              c="var(--mantine-color-text)"
              aria-hidden
            >
              {openCount}
            </Badge>
          ) : undefined
        }
        ref={setControl}
        aria-label={controlLabel}
        aria-expanded={opened}
        aria-haspopup="dialog"
        onClick={(event) => (!opened ? open() : event.detail > 0 ? closeByPointer() : close())}
        data-testid={testId}
      >
        Comment on this entry
      </Button>
    ) : (
      // One element for every state, so a count change never remounts the control focus returns to.
      <Button
        variant={openCount > 0 ? 'light' : 'subtle'}
        color={openCount > 0 ? 'orange' : 'gray'}
        c={openCount > 0 ? 'var(--mantine-color-text)' : undefined}
        size="compact-xs"
        px={4}
        ref={setControl}
        tabIndex={idle ? -1 : undefined}
        aria-label={controlLabel}
        aria-expanded={opened}
        aria-haspopup="dialog"
        aria-controls={anchored && opened ? `${popoverId}-dropdown` : undefined}
        aria-keyshortcuts={commentsAriaKeyShortcuts()}
        onClick={(event) => (!opened ? open() : event.detail > 0 ? closeByPointer() : close())}
        data-testid={testId}
        data-comment-control
        data-revealed={shown ? '' : undefined}
        style={{
          // Hidden by opacity, not display, so a pointer or focus on the field shows it in place.
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
              color={openCount > 0 ? 'var(--mantine-color-orange-text)' : undefined}
              aria-hidden
            />
          )}
          {openCount > 0 && <span>{openCount}</span>}
        </Group>
      </Button>
    )

  const tooltipTarget =
    variant === 'entry' ? (
      target
    ) : (
      <Tooltip label={controlTooltip} withinPortal disabled={opened}>
        {target}
      </Tooltip>
    )

  const popover = (
    <Popover
      id={popoverId}
      opened={opened}
      onChange={(next) => (next ? open() : close())}
      onClose={close}
      // Never over the field's input; the entry's button sits above the form.
      position={anchored && side === 'below' ? 'bottom-start' : 'top-start'}
      // Clamped to the room on its side, scrolling inside, since it never flips over the input.
      middlewares={anchored ? { flip: false, shift: true, size: { padding: 8 } } : undefined}
      width={380}
      shadow="md"
      withArrow={!anchored}
      trapFocus
      returnFocus={false}
      // Off while a write is in flight, when `close` refuses anyway, so Mantine's Escape handler
      // doesn't run its focus return on a popover that stays open.
      closeOnEscape={inFlight === 0}
      closeOnClickOutside={!anchored}
      // Anchored, the target is an empty element, so the control and dropdown carry the roles.
      withRoles={!anchored}
    >
      <Popover.Target>
        {anchored ? <AnchorTarget node={anchors?.[side]} /> : tooltipTarget}
      </Popover.Target>
      <Popover.Dropdown
        ref={setDropdownNode}
        aria-label={`Comments on ${subject}`}
        {...(anchored ? { role: 'dialog', id: `${popoverId}-dropdown`, tabIndex: -1 } : {})}
        style={anchored ? { overflowY: 'auto' } : undefined}
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
                      fieldLabel={threadFieldLabel?.(thread)}
                    />
                  </div>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
          {sortedThreads.length === 0 || composing ? (
            <NewThreadComposer
              blockedReason={composeBlockedReason}
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
          <CloseRefusedNotice refused={closeRefused} />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )

  return anchored ? (
    <>
      {tooltipTarget}
      {popover}
    </>
  ) : (
    popover
  )
}

/** An empty element placed in `node`, as the popover's position reference. */
const AnchorTarget = React.forwardRef<HTMLDivElement, { node: HTMLElement | null | undefined }>(
  function AnchorTarget({ node }, ref) {
    return node ? createPortal(<div ref={ref} aria-hidden />, node) : null
  },
)

const NewThreadComposer: React.FC<{
  text: string
  onTextChange: (text: string) => void
  onSubmit: (text: string) => Promise<void>
  onCancel: () => void
  blockedReason?: string
}> = ({ text, onTextChange: setText, onSubmit, onCancel, blockedReason }) => {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  // Shown on request ("New thread"), so it takes focus.
  useEffect(() => {
    boxRef.current?.focus()
  }, [])
  useRefocusAfterSubmit(submitting, boxRef)

  const submit = async () => {
    if (!text.trim() || blockedReason) return
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

  const button = (
    <Button
      size="compact-sm"
      onClick={() => void submit()}
      loading={submitting}
      disabled={!text.trim()}
      data-disabled={blockedReason ? true : undefined}
      aria-disabled={blockedReason ? true : undefined}
      data-testid="create-thread-button"
    >
      Comment
    </Button>
  )
  // `aria-disabled` keeps it focusable for its reason. Unblocked it isn't wrapped: around a focused
  // button the Tooltip keeps Escape from the listener that refuses a close mid-post.
  const commentButton = blockedReason ? (
    <Tooltip label={blockedReason} multiline maw={280}>
      {button}
    </Tooltip>
  ) : (
    button
  )

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
        description={blockedReason}
        error={error ?? undefined}
        data-autofocus
        data-testid="new-thread-textarea"
      />
      <Group gap="xs">
        {commentButton}
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
