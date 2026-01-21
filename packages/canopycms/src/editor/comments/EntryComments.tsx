'use client'

import React, { useMemo, useState } from 'react'
import { Box, Button } from '@mantine/core'
import type { CommentThread } from '../../comment-store'
import { ThreadCarousel } from './ThreadCarousel'

export interface EntryCommentsProps {
  /** All comments (will be filtered for entry-level) */
  comments: CommentThread[]
  /** Current entry path */
  entryPath: string
  /** Current user ID */
  currentUserId: string
  /** Whether user can resolve threads */
  canResolve: boolean
  /** Handler to add a comment */
  onAddComment: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryPath?: string,
    canopyPath?: string,
    threadId?: string,
  ) => Promise<void>
  /** Handler to resolve a thread */
  onResolveThread: (threadId: string) => Promise<void>
  /** Auto-focus and expand */
  autoFocus?: boolean
  /** Thread ID to highlight and scroll to */
  highlightThreadId?: string
}

/**
 * Entry-level comments section displayed at the top of the form.
 * Uses ThreadCarousel for navigation.
 */
export const EntryComments: React.FC<EntryCommentsProps> = ({
  comments,
  entryPath,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  autoFocus,
  highlightThreadId,
}) => {
  const [showCarousel, setShowCarousel] = useState(false)

  // Filter for entry-level threads
  const entryThreads = useMemo(
    () => comments.filter((t) => t.type === 'entry' && t.entryPath === entryPath),
    [comments, entryPath],
  )

  // Show carousel if threads exist or if auto-focused
  const shouldShowCarousel = entryThreads.length > 0 || showCarousel || autoFocus

  // Wrapper to add entry context to comment handler
  const handleAddComment = async (text: string, threadId?: string) => {
    await onAddComment(text, 'entry', entryPath, undefined, threadId)
  }

  // Show "New file comment" button when no threads
  if (!shouldShowCarousel) {
    return (
      <Box>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          onClick={() => setShowCarousel(true)}
          style={{ fontSize: '0.75rem', height: '1.5rem' }}
        >
          New file comment
        </Button>
      </Box>
    )
  }

  return (
    <ThreadCarousel
      threads={entryThreads}
      label="Entry Comments"
      contextType="entry"
      currentUserId={currentUserId}
      canResolve={canResolve}
      onAddComment={handleAddComment}
      onResolveThread={onResolveThread}
      autoFocus={autoFocus}
      autoOpenNewThread={showCarousel && entryThreads.length === 0}
      highlightThreadId={highlightThreadId}
    />
  )
}
