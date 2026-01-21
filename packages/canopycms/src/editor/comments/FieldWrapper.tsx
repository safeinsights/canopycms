'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Box, Button } from '@mantine/core'
import type { CommentThread } from '../../comment-store'
import { ThreadCarousel } from './ThreadCarousel'

export interface FieldWrapperProps {
  /** Child form field element */
  children: React.ReactNode
  /** CanopyPath identifying this field */
  canopyPath: string
  /** Entry path for this field */
  entryPath: string
  /** All comment threads for this field */
  threads: CommentThread[]
  /** Whether to auto-expand comments (from preview click) */
  autoFocus?: boolean
  /** Current user ID */
  currentUserId: string
  /** Whether user can resolve threads */
  canResolve: boolean
  /** Handler to add a comment (receives full context) */
  onAddComment: (text: string, type: 'field' | 'entry' | 'branch', entryPath?: string, canopyPath?: string, threadId?: string) => Promise<void>
  /** Handler to resolve a thread */
  onResolveThread: (threadId: string) => Promise<void>
  /** Field label for positioning the new comment button */
  fieldLabel?: string
  /** Thread ID to highlight and scroll to */
  highlightThreadId?: string
}

/**
 * Wraps a form field with inline comment functionality.
 * Shows ThreadCarousel when comments exist or when user clicks "New comment".
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
  highlightThreadId,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [showCarousel, setShowCarousel] = useState(false)

  // Show carousel if threads exist or if auto-focused
  const shouldShowCarousel = threads.length > 0 || showCarousel || autoFocus

  // Scroll to field when focused from preview
  useEffect(() => {
    if (autoFocus) {
      setShowCarousel(true)
      wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [autoFocus])

  // Wrapper to add field context to comment handler
  const handleAddComment = async (text: string, threadId?: string) => {
    await onAddComment(text, 'field', entryPath, canopyPath, threadId)
  }

  return (
    <Box ref={wrapperRef} data-canopy-field={canopyPath} pos="relative" style={{ width: '100%' }}>
      <Box
        style={{
          // Add subtle highlight when auto-focused
          outline: autoFocus ? '2px solid var(--mantine-color-blue-5)' : undefined,
          outlineOffset: autoFocus ? 2 : undefined,
          borderRadius: 4,
          transition: 'outline 0.2s ease',
        }}
      >
        {children}
      </Box>

      {/* Show "New comment" button when no threads and not showing carousel */}
      {!shouldShowCarousel && (
        <Box
          style={{
            position: 'absolute',
            top: 4,
            right: 8,
            zIndex: 1,
          }}
        >
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => setShowCarousel(true)}
            style={{ fontSize: '0.75rem', height: '1.5rem' }}
          >
            New comment
          </Button>
        </Box>
      )}

      {/* Render ThreadCarousel when threads exist or user requested it */}
      {shouldShowCarousel && (
        <ThreadCarousel
          threads={threads}
          contextType="field"
          currentUserId={currentUserId}
          canResolve={canResolve}
          onAddComment={handleAddComment}
          onResolveThread={onResolveThread}
          autoFocus={autoFocus}
          autoOpenNewThread={showCarousel && threads.length === 0}
          highlightThreadId={highlightThreadId}
        />
      )}
    </Box>
  )
}
