'use client'

import React, { useEffect, useRef } from 'react'
import { Box } from '@mantine/core'
import type { CommentThread } from '../../comment-store'
import { FieldCommentBadge } from './FieldCommentBadge'

export interface FieldWrapperProps {
  /** Child form field element */
  children: React.ReactNode
  /** CanopyPath identifying this field */
  canopyPath: string
  /** All comment threads for this field */
  threads: CommentThread[]
  /** Whether to auto-open thread panel for this field */
  autoFocus?: boolean
  /** Handler when badge is clicked or auto-focus triggers */
  onOpenThreadPanel: (canopyPath: string) => void
  /** Custom unresolved color from config */
  unresolvedColor?: string
  /** Custom resolved color from config */
  resolvedColor?: string
}

/**
 * Wraps a form field with comment functionality.
 * Displays badge when comments exist, handles auto-focus from preview clicks.
 */
export const FieldWrapper: React.FC<FieldWrapperProps> = ({
  children,
  canopyPath,
  threads,
  autoFocus,
  onOpenThreadPanel,
  unresolvedColor,
  resolvedColor,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Auto-open thread panel when focused from preview
  useEffect(() => {
    if (autoFocus) {
      onOpenThreadPanel(canopyPath)
      // Scroll to field
      wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [autoFocus, canopyPath, onOpenThreadPanel])

  const unresolvedThreads = threads.filter((t) => !t.resolved)
  const totalCount = threads.reduce((sum, t) => sum + t.comments.length, 0)
  const unresolvedCount = unresolvedThreads.reduce((sum, t) => sum + t.comments.length, 0)
  const allResolved = threads.length > 0 && unresolvedThreads.length === 0

  return (
    <Box
      ref={wrapperRef}
      pos="relative"
      data-canopy-field={canopyPath}
      style={{
        // Add subtle highlight when auto-focused
        outline: autoFocus ? '2px solid var(--mantine-color-blue-5)' : undefined,
        outlineOffset: autoFocus ? 2 : undefined,
        borderRadius: 4,
        transition: 'outline 0.2s ease',
      }}
    >
      {children}

      <FieldCommentBadge
        count={totalCount}
        unresolvedCount={unresolvedCount}
        resolved={allResolved}
        onClick={() => onOpenThreadPanel(canopyPath)}
        unresolvedColor={unresolvedColor}
        resolvedColor={resolvedColor}
      />
    </Box>
  )
}
