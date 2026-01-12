'use client'

import React, { useState, useMemo, useEffect, useRef } from 'react'
import { ActionIcon, Alert, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import { IconChevronLeft, IconChevronRight, IconAlertCircle } from '@tabler/icons-react'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { InlineCommentThread } from './InlineCommentThread'

/**
 * ThreadCarousel - Horizontal comment thread navigation component
 *
 * ## Purpose
 * Provides a horizontal carousel UI for navigating between multiple comment threads
 * on fields, entries, or branches. Supports both keyboard navigation (arrow buttons)
 * and displays a visual "peekaboo" preview of adjacent threads.
 *
 * ## Key Behaviors
 *
 * ### Layout & Sizing
 * - **Active thread width**: `calc(100% - 72px)` - fills container minus peekaboo space
 * - **Single thread width**: `calc(100% - 72px)` - same as active (for consistency)
 * - **Inactive thread width**: `400px` - fixed width when not in view
 * - **Peekaboo size**: `60px` - sliver of next thread shown on right edge
 * - **Gap between threads**: `12px`
 *
 * ### Peekaboo Preview
 * - Shows 60px of the next thread on the right edge (when not viewing last thread)
 * - Gradient fade overlay applied to peekaboo area for visual polish
 * - **Last thread behavior**: Invisible 60px spacer ensures last thread stays left-aligned
 *   without showing previous threads on the left
 * - Peekaboo helps users discover there are more threads to navigate
 *
 * ### Thread Sorting
 * - **Unresolved threads first** (primary sort)
 * - **Newest first within same resolved state** (secondary sort by createdAt)
 * - This ensures urgent unresolved feedback appears first
 *
 * ### Navigation
 * - **Arrow buttons**: `← 2/5 →` counter with disabled states at boundaries
 * - **Smooth scrolling**: CSS `scroll-behavior: smooth` with programmatic scroll
 * - **Auto-scroll**: When `autoFocus` is true, automatically scrolls to first unresolved thread
 * - **Mouse scrolling disabled**: `overflowX: 'hidden'` - only button navigation allowed
 * - **Scroll calculation**: Accounts for active thread width + gaps when navigating
 *
 * ### Always-Visible Design
 * - Component renders even with 0 threads (shows "No comments yet" message)
 * - "New" button always accessible in header
 * - Header shows thread count when threads exist: "Comments (3)"
 * - Navigation arrows only appear when multiple threads exist
 *
 * ### Vertical Resizing
 * - **Default height**: 400px
 * - **Resize range**: 200px (min) to 600px (max)
 * - **Resize handle**: Bottom edge with visual feedback on hover/drag
 * - User can drag to adjust carousel height for their workflow
 *
 * ### New Thread Creation
 * - "New" button in header toggles inline thread creation box
 * - `autoOpenNewThread` prop auto-opens box (used when clicking "New comment" button)
 * - New thread box appears above carousel, with textarea and Create/Cancel buttons
 *
 * ## Usage Context
 * Used by:
 * - **FieldWrapper**: Inline comments beneath form fields
 * - **EntryComments**: Comments at top of entry form
 * - **BranchComments**: Comments at top of BranchManager
 *
 * ## Design Decisions
 *
 * ### Why calc(100% - 72px)?
 * - 60px for peekaboo preview + 12px gap = 72px total
 * - Active thread fills remaining space for maximum readability
 * - Consistent sizing between single thread and active thread in multi-thread scenarios
 *
 * ### Why invisible spacer at end?
 * - Without spacer: last thread would align to right edge, showing previous threads on left
 * - With spacer: last thread stays left-aligned with blank space on right (matching peekaboo size)
 * - Creates consistent left-alignment across all thread positions
 *
 * ### Why disable mouse scrolling?
 * - Prevents accidental scroll-wheel navigation that could be jarring
 * - Forces deliberate button-based navigation for better UX
 * - Scroll-snap still works programmatically for smooth transitions
 *
 * ### Why sort unresolved first?
 * - Unresolved threads require action, so they should be most visible
 * - Resolved threads are less urgent and can appear later in carousel
 * - Newest-first secondary sort ensures recent feedback is prioritized
 */

export interface ThreadCarouselProps {
  /** All threads for this context */
  threads: CommentThread[]
  /** Label for the comment section (e.g., "Comments", "Entry Comments") */
  label?: string
  /** Context type for creating new threads */
  contextType: 'field' | 'entry' | 'branch'
  /** Current user ID */
  currentUserId: string
  /** Whether user can resolve threads */
  canResolve: boolean
  /** Handler to add a new comment (creates new thread or adds to existing) */
  onAddComment: (text: string, threadId?: string) => Promise<void>
  /** Handler to resolve a thread */
  onResolveThread: (threadId: string) => Promise<void>
  /** Auto-focus and expand (from preview click) */
  autoFocus?: boolean
  /** Auto-open new thread box */
  autoOpenNewThread?: boolean
  /** Thread ID to highlight and scroll to */
  highlightThreadId?: string
  /** Optional function to fetch user metadata for displaying user badges */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
}
export const ThreadCarousel: React.FC<ThreadCarouselProps> = ({
  threads,
  label = 'Comments',
  contextType,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  autoFocus,
  autoOpenNewThread,
  highlightThreadId,
  onGetUserMetadata,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [showNewThreadBox, setShowNewThreadBox] = useState(false)
  const [newThreadText, setNewThreadText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [carouselHeight, setCarouselHeight] = useState(400)
  const [isResizing, setIsResizing] = useState(false)
  const [highlightedThreadId, setHighlightedThreadId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeStartY = useRef<number>(0)
  const resizeStartHeight = useRef<number>(0)

  // Sort: unresolved first, then resolved
  const sortedThreads = useMemo(
    () =>
      [...threads].sort((a, b) => {
        if (a.resolved === b.resolved) {
          // Same resolved state: sort by createdAt (newest first)
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        }
        return a.resolved ? 1 : -1
      }),
    [threads],
  )

  // Auto-scroll to first unresolved thread when autoFocus is true
  useEffect(() => {
    if (autoFocus && sortedThreads.length > 0) {
      const firstUnresolved = sortedThreads.find((t) => !t.resolved)
      if (firstUnresolved) {
        const index = sortedThreads.findIndex((t) => t.id === firstUnresolved.id)
        setCurrentIndex(index)
        // Scroll to thread
        scrollToIndex(index)
      }
    }
  }, [autoFocus, sortedThreads])

  // Scroll to and highlight specific thread when highlightThreadId changes
  useEffect(() => {
    if (highlightThreadId && sortedThreads.length > 0) {
      const threadIndex = sortedThreads.findIndex((t) => t.id === highlightThreadId)
      if (threadIndex !== -1) {
        setCurrentIndex(threadIndex)
        scrollToIndex(threadIndex)
        setHighlightedThreadId(highlightThreadId)
        // Clear highlight after 2 seconds
        const timer = window.setTimeout(() => {
          setHighlightedThreadId(undefined)
        }, 2000)
        return () => window.clearTimeout(timer)
      }
    }
  }, [highlightThreadId, sortedThreads])

  // Auto-open new thread box when autoOpenNewThread is true
  useEffect(() => {
    if (autoOpenNewThread) {
      setShowNewThreadBox(true)
    }
  }, [autoOpenNewThread])

  // Handle resize dragging
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const delta = e.clientY - resizeStartY.current
      const newHeight = Math.max(200, Math.min(600, resizeStartHeight.current + delta))
      setCarouselHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isResizing])

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    resizeStartY.current = e.clientY
    resizeStartHeight.current = carouselHeight
  }

  const scrollToIndex = (index: number) => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current
      // Calculate scroll position based on container width
      // Active thread takes most space, others are 400px + gap
      let scrollLeft = 0
      for (let i = 0; i < index; i++) {
        if (sortedThreads.length > 1) {
          // Each previous thread was the active one when visible, so use full width
          scrollLeft += container.clientWidth - 72 + 12 // width - peekaboo + gap
        } else {
          scrollLeft += 400 + 12
        }
      }
      container.scrollTo({
        left: scrollLeft,
        behavior: 'smooth',
      })
    }
  }

  const handlePrevious = () => {
    if (currentIndex > 0) {
      const newIndex = currentIndex - 1
      setCurrentIndex(newIndex)
      scrollToIndex(newIndex)
    }
  }

  const handleNext = () => {
    if (currentIndex < sortedThreads.length - 1) {
      const newIndex = currentIndex + 1
      setCurrentIndex(newIndex)
      scrollToIndex(newIndex)
    }
  }

  const handleAddReply = async (threadId: string, text: string) => {
    try {
      setError(null)
      await onAddComment(text, threadId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add reply')
      throw err // Re-throw so InlineCommentThread can handle it
    }
  }

  const handleCreateNewThread = async () => {
    if (!newThreadText.trim()) return

    setIsSubmitting(true)
    setError(null)
    try {
      await onAddComment(newThreadText)
      setNewThreadText('')
      setShowNewThreadBox(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create comment')
    } finally {
      setIsSubmitting(false)
    }
  }

  const unresolvedCount = sortedThreads.filter((t) => !t.resolved).length

  return (
    <Paper p="sm" bg="gray.0" style={{ marginTop: 8 }}>
      <Stack gap="xs">
        {/* Header: always visible */}
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <Text size="sm" fw={600}>
              {label}
              {sortedThreads.length > 0 && ` (${sortedThreads.length})`}
            </Text>
            {unresolvedCount > 0 && (
              <Text size="xs" c="orange" fw={600}>
                {unresolvedCount} unresolved
              </Text>
            )}
          </Group>

          <Group gap="xs">
            {/* Navigation arrows (only if multiple threads) */}
            {sortedThreads.length > 1 && (
              <>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  onClick={handlePrevious}
                  disabled={currentIndex === 0}
                >
                  <IconChevronLeft size={16} />
                </ActionIcon>
                <Text size="xs" fw={500}>
                  {currentIndex + 1}/{sortedThreads.length}
                </Text>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  onClick={handleNext}
                  disabled={currentIndex === sortedThreads.length - 1}
                >
                  <IconChevronRight size={16} />
                </ActionIcon>
                <div style={{ width: 1, height: 16, background: 'var(--mantine-color-gray-4)' }} />
              </>
            )}

            {/* New button (always visible) */}
            <Button
              size="xs"
              variant="light"
              onClick={() => setShowNewThreadBox(!showNewThreadBox)}
            >
              + New
            </Button>
          </Group>
        </Group>

        {/* Error display */}
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

        {/* New thread box */}
        {showNewThreadBox && (
          <Paper withBorder p="sm" bg="white">
            <Stack gap="xs">
              <Textarea
                placeholder="Start a new thread..."
                value={newThreadText}
                onChange={(e) => setNewThreadText(e.target.value)}
                minRows={2}
                disabled={isSubmitting}
                autoFocus
              />
              <Group gap="xs">
                <Button
                  size="xs"
                  onClick={handleCreateNewThread}
                  loading={isSubmitting}
                  disabled={!newThreadText.trim()}
                >
                  Create Thread
                </Button>
                <Button size="xs" variant="subtle" onClick={() => setShowNewThreadBox(false)}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          </Paper>
        )}

        {/* Thread carousel */}
        {sortedThreads.length > 0 && (
          <div
            style={{
              position: 'relative',
              width: '100%',
            }}
          >
            <div
              ref={scrollContainerRef}
              style={{
                display: 'flex',
                gap: 12,
                overflowX: 'hidden', // Disable mouse scrolling
                scrollSnapType: 'x mandatory',
                scrollBehavior: 'smooth',
                maxHeight: carouselHeight,
                position: 'relative',
                width: '100%', // Ensure container respects parent width boundary
              }}
            >
              {sortedThreads.map((thread, idx) => {
                const isActive = idx === currentIndex
                const isHighlighted = thread.id === highlightedThreadId

                return (
                  <div
                    key={thread.id}
                    style={{
                      scrollSnapAlign: 'start',
                      flexShrink: 0,
                      // Active thread or single thread stretches to fill space minus peekaboo
                      width:
                        isActive || sortedThreads.length === 1
                          ? 'calc(100% - 72px)' // Active or single: leave room for peekaboo/spacing
                          : 400, // Non-active: fixed width
                      maxWidth: isActive || sortedThreads.length === 1 ? 'calc(100% - 72px)' : 400,
                      // Add highlight animation
                      outline: isHighlighted ? '3px solid var(--mantine-color-blue-5)' : undefined,
                      outlineOffset: isHighlighted ? 2 : undefined,
                      borderRadius: isHighlighted ? 8 : undefined,
                      transition: 'outline 0.3s ease, outline-offset 0.3s ease',
                    }}
                  >
                    <InlineCommentThread
                      thread={thread}
                      onAddReply={(text) => handleAddReply(thread.id, text)}
                      onResolve={() => onResolveThread(thread.id)}
                      currentUserId={currentUserId}
                      canResolve={canResolve}
                      onGetUserMetadata={onGetUserMetadata}
                    />
                  </div>
                )
              })}

              {/* Invisible spacer at end to maintain left alignment for last thread */}
              {sortedThreads.length > 1 && (
                <div
                  style={{
                    flexShrink: 0,
                    width: 60, // Match peekaboo size
                    visibility: 'hidden',
                  }}
                />
              )}
            </div>

            {/* Peekaboo gradient fade overlay */}
            {sortedThreads.length > 1 && currentIndex < sortedThreads.length - 1 && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  width: 60,
                  height: '100%',
                  background:
                    'linear-gradient(to left, var(--mantine-color-gray-0) 0%, transparent 100%)',
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* Resize handle */}
            <div
              onMouseDown={handleResizeStart}
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 8,
                cursor: 'ns-resize',
                background: isResizing ? 'var(--mantine-color-blue-5)' : 'transparent',
                transition: 'background 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--mantine-color-gray-3)'
              }}
              onMouseLeave={(e) => {
                if (!isResizing) {
                  e.currentTarget.style.background = 'transparent'
                }
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 3,
                  borderRadius: 2,
                  background: 'var(--mantine-color-gray-5)',
                }}
              />
            </div>
          </div>
        )}

        {/* Empty state */}
        {sortedThreads.length === 0 && !showNewThreadBox && (
          <Text size="xs" c="dimmed" ta="center" py="xs">
            No comments yet. Click "+ New" to start a thread.
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
