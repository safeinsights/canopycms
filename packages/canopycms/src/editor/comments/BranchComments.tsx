'use client'

import React, { useMemo, useState } from 'react'
import { Box, Button } from '@mantine/core'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { ThreadCarousel } from './ThreadCarousel'

export interface BranchCommentsProps {
  /** All comments (will be filtered for branch-level) */
  comments: CommentThread[]
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
  /** Optional function to fetch user metadata for displaying user badges */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
}

/**
 * Branch-level comments section displayed at the top of BranchManager.
 * Uses ThreadCarousel for navigation.
 */
export const BranchComments: React.FC<BranchCommentsProps> = ({
  comments,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  autoFocus,
  highlightThreadId,
  onGetUserMetadata,
}) => {
  const [showCarousel, setShowCarousel] = useState(false)

  // Filter for branch-level threads
  const branchThreads = useMemo(() => comments.filter((t) => t.type === 'branch'), [comments])

  // Show carousel if threads exist or if auto-focused
  const shouldShowCarousel = branchThreads.length > 0 || showCarousel || autoFocus

  // Wrapper to add branch context to comment handler
  const handleAddComment = async (text: string, threadId?: string) => {
    await onAddComment(text, 'branch', undefined, undefined, threadId)
  }

  // Show "New branch comment" button when no threads
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
          New branch comment
        </Button>
      </Box>
    )
  }

  return (
    <ThreadCarousel
      threads={branchThreads}
      label="Branch Discussion"
      contextType="branch"
      currentUserId={currentUserId}
      canResolve={canResolve}
      onAddComment={handleAddComment}
      onResolveThread={onResolveThread}
      autoFocus={autoFocus}
      autoOpenNewThread={showCarousel && branchThreads.length === 0}
      highlightThreadId={highlightThreadId}
      onGetUserMetadata={onGetUserMetadata}
    />
  )
}
