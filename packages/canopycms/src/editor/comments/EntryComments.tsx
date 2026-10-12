'use client'

import React, { useMemo } from 'react'
import { Group } from '@mantine/core'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { CommentThreadsPopover } from './CommentThreadsPopover'
import { FormCommentsMenu } from './form-comments'

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
  /** Thread ID to highlight and scroll to */
  highlightThreadId?: string
  /** Resolves author ids to names; without it authors show as ids. */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** Changes with the entry or branch, which resets the popover, so a draft never posts elsewhere. */
  resetKey: string
}

/**
 * The top of the form's comment actions: the "Comments in this form" menu, the keyboard route to
 * field comments, and "Comment on this entry" with the entry's threads.
 */
export const EntryComments: React.FC<EntryCommentsProps> = ({
  comments,
  entryPath,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  highlightThreadId,
  onGetUserMetadata,
  resetKey,
}) => {
  const entryThreads = useMemo(
    () => comments.filter((t) => t.type === 'entry' && t.entryPath === entryPath),
    [comments, entryPath],
  )

  return (
    <Group justify="flex-end" gap="xs">
      <FormCommentsMenu comments={comments} entryPath={entryPath} />
      <CommentThreadsPopover
        key={resetKey}
        threads={entryThreads}
        subject="this entry"
        variant="entry"
        currentUserId={currentUserId}
        canResolve={canResolve}
        onAddComment={(text, threadId) =>
          onAddComment(text, 'entry', entryPath, undefined, threadId)
        }
        onResolveThread={onResolveThread}
        onGetUserMetadata={onGetUserMetadata}
        highlightThreadId={highlightThreadId}
        testId="entry-comment-button"
      />
    </Group>
  )
}
