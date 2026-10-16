'use client'

import React, { useMemo } from 'react'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { ThreadCarousel } from './ThreadCarousel'

export interface BranchCommentsProps {
  /** All comments (will be filtered for branch-level) */
  comments: CommentThread[]
  /** Current user ID */
  currentUserId: string
  /** Whether the user may resolve any thread; a thread's own author always may resolve it. */
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
  /** Thread ID to highlight and scroll to */
  highlightThreadId?: string
  /** Optional function to fetch user metadata for displaying user badges */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
}

/**
 * The branch's existing discussion threads, at the top of BranchManager, in a ThreadCarousel.
 * It renders nothing without one: a new branch comment starts in the Comments drawer.
 */
export const BranchComments: React.FC<BranchCommentsProps> = ({
  comments,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  highlightThreadId,
  onGetUserMetadata,
}) => {
  const branchThreads = useMemo(() => comments.filter((t) => t.type === 'branch'), [comments])

  const handleAddComment = async (text: string, threadId?: string) => {
    await onAddComment(text, 'branch', undefined, undefined, threadId)
  }

  if (branchThreads.length === 0) return null

  return (
    <ThreadCarousel
      threads={branchThreads}
      label="Branch discussion"
      contextType="branch"
      currentUserId={currentUserId}
      canResolve={canResolve}
      onAddComment={handleAddComment}
      onResolveThread={onResolveThread}
      highlightThreadId={highlightThreadId}
      onGetUserMetadata={onGetUserMetadata}
    />
  )
}
