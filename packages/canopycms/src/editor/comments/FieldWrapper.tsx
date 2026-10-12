'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box } from '@mantine/core'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { CommentThreadsPopover, type OpenRequest } from './CommentThreadsPopover'
import { FieldCommentContext } from './field-comment-context'
import { useFormComments } from './form-comments'

export interface FieldWrapperProps {
  /** Child form field element */
  children: React.ReactNode
  /** CanopyPath identifying this field */
  canopyPath: string
  /** Entry path for this field */
  entryPath: string
  /** All comment threads for this field */
  threads: CommentThread[]
  /** Whether this field is focused from a preview click (scrolls into view and highlights) */
  autoFocus?: boolean
  /** Current user ID */
  currentUserId: string
  /** Whether user can resolve threads */
  canResolve: boolean
  /** Handler to add a comment (receives full context) */
  onAddComment: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryPath?: string,
    canopyPath?: string,
    threadId?: string,
  ) => Promise<void>
  /** Handler to resolve a thread */
  onResolveThread: (threadId: string) => Promise<void>
  /** The field's breadcrumb ("Links › /a › Href"), which names the control: "Comment on <breadcrumb>". */
  fieldLabel: string
  /** Thread ID to highlight and scroll to */
  highlightThreadId?: string
  /** Resolves author ids to names; without it authors show as ids. */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /**
   * `label`: the field puts the control in its `FieldLabel` via `useFieldCommentControl`.
   * `corner`: the wrapper places it at the top right, for custom renderers, whose labels are
   * their own.
   */
  controlPlacement?: 'label' | 'corner'
  /** Changes with the entry or branch, which resets the popover, so a draft never posts elsewhere. */
  resetKey: string
}

const FIELD_SCOPE_ATTR = 'data-field-comments'

/**
 * Gives a form field its comment control. The control shows while the pointer or focus is on
 * this field and not on a field nested inside it, so a group never shows a second icon for its
 * children; a field with open threads always shows it.
 */
export const FieldWrapper: React.FC<FieldWrapperProps> = ({
  children,
  canopyPath,
  entryPath,
  threads,
  autoFocus,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  fieldLabel,
  highlightThreadId,
  onGetUserMetadata,
  controlPlacement = 'label',
  resetKey,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [pointerOn, setPointerOn] = useState(false)
  const [focusOn, setFocusOn] = useState(false)
  const [above, setAbove] = useState<HTMLDivElement | null>(null)
  const [below, setBelow] = useState<HTMLDivElement | null>(null)
  const anchors = useMemo(() => ({ above, below }), [above, below])
  // A highlighted thread here opens the popover, which scrolls the field itself.
  const highlightHere = !!highlightThreadId && threads.some((t) => t.id === highlightThreadId)
  const [openRequest, setOpenRequest] = useState<OpenRequest | undefined>(undefined)
  const formComments = useFormComments()

  useEffect(
    () =>
      formComments?.register(canopyPath, {
        subject: fieldLabel,
        // A new object per request, so asking again while it is open still counts.
        open: (returnFocusTo) => setOpenRequest({ returnFocusTo }),
        element: () => wrapperRef.current,
      }),
    [formComments, canopyPath, fieldLabel],
  )

  useEffect(() => {
    if (autoFocus && !highlightHere) {
      wrapperRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }
  }, [autoFocus, highlightHere])

  // Events from a nested field, or from a popover portalled out of the DOM, have another
  // closest scope (or none), so they leave this field's icon hidden.
  const ownsTarget = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    wrapperRef.current !== null &&
    target.closest(`[${FIELD_SCOPE_ATTR}]`) === wrapperRef.current

  const control = (
    <CommentThreadsPopover
      key={resetKey}
      threads={threads}
      subject={fieldLabel}
      variant="field"
      revealed={pointerOn || focusOn}
      anchors={anchors}
      openRequest={openRequest}
      currentUserId={currentUserId}
      canResolve={canResolve}
      onAddComment={(text, threadId) =>
        onAddComment(text, 'field', entryPath, canopyPath, threadId)
      }
      onResolveThread={onResolveThread}
      onGetUserMetadata={onGetUserMetadata}
      highlightThreadId={highlightThreadId}
      testId={`field-comment-${canopyPath}`}
    />
  )

  return (
    <Box
      ref={wrapperRef}
      data-canopy-field={canopyPath}
      {...{ [FIELD_SCOPE_ATTR]: '' }}
      pos="relative"
      style={{ width: '100%' }}
      onMouseOver={(event: React.MouseEvent) => setPointerOn(ownsTarget(event.target))}
      onMouseLeave={() => setPointerOn(false)}
      onFocus={(event: React.FocusEvent) => {
        const owned = ownsTarget(event.target)
        setFocusOn(owned)
        if (owned) formComments?.noteFocus(canopyPath)
      }}
      onBlur={(event: React.FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget
        if (!(next instanceof Node && event.currentTarget.contains(next))) setFocusOn(false)
      }}
    >
      {/* The comment popover opens above this or beneath the one below, never over the input. */}
      <div ref={setAbove} data-comment-anchor="above" />
      <FieldCommentContext.Provider value={{ canopyPath, control }}>
        <Box
          style={{
            outline: autoFocus ? '2px solid var(--mantine-color-blue-5)' : undefined,
            outlineOffset: autoFocus ? 2 : undefined,
            borderRadius: 4,
            transition: 'outline 0.2s ease',
          }}
        >
          {children}
        </Box>
      </FieldCommentContext.Provider>
      <div ref={setBelow} data-comment-anchor="below" />
      {controlPlacement === 'corner' && (
        <Box pos="absolute" top={4} right={4} style={{ zIndex: 1 }}>
          {control}
        </Box>
      )}
    </Box>
  )
}
