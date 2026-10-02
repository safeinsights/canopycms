'use client'

import React, { useState, useMemo, useEffect, useRef } from 'react'
import { ActionIcon, Alert, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import { IconChevronLeft, IconChevronRight, IconAlertCircle } from '@tabler/icons-react'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import { InlineCommentThread } from './InlineCommentThread'

/**
 * ## Purpose
 * Provides a horizontal carousel UI for navigating between multiple comment threads
 * on fields, entries, or branches. Supports both keyboard navigation (arrow buttons)
 * and displays a visual "peekaboo" preview of adjacent threads.
 *
 * ## Design Decisions
 *
 * ### Why calc(100% - 72px)?
 * - 60px for peekaboo preview + 12px gap = 72px total
 * - Active thread fills remaining space for maximum readability
 * - Consistent sizing between single thread and active thread in multi-thread scenarios
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
  /** Called when the user cancels the new-thread box (e.g. so a wrapper can collapse an empty carousel) */
  onCancelNewThread?: () => void
}
export const ThreadCarousel: React.FC<ThreadCarouselProps> = ({
  threads,
  label = 'Comments',
  contextType: _,
  currentUserId,
  canResolve,
  onAddComment,
  onResolveThread,
  autoFocus,
  autoOpenNewThread,
  highlightThreadId,
  onGetUserMetadata,
  onCancelNewThread,
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

  const sortedThreads = useMemo(
    () =>
      [...threads].sort((a, b) => {
        if (a.resolved === b.resolved) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        }
        return a.resolved ? 1 : -1
      }),
    [threads],
  )

  useEffect(() => {
    if (autoFocus && sortedThreads.length > 0) {
      const firstUnresolved = sortedThreads.find((t) => !t.resolved)
      if (firstUnresolved) {
        const index = sortedThreads.findIndex((t) => t.id === firstUnresolved.id)
        setCurrentIndex(index)
        scrollToIndex(index)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToIndex is stable
  }, [autoFocus, sortedThreads])

  useEffect(() => {
    if (highlightThreadId && sortedThreads.length > 0) {
      const threadIndex = sortedThreads.findIndex((t) => t.id === highlightThreadId)
      if (threadIndex !== -1) {
        setCurrentIndex(threadIndex)
        scrollToIndex(threadIndex)
        setHighlightedThreadId(highlightThreadId)
        const timer = window.setTimeout(() => {
          setHighlightedThreadId(undefined)
        }, 2000)
        return () => window.clearTimeout(timer)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToIndex is stable
  }, [highlightThreadId, sortedThreads])

  useEffect(() => {
    if (autoOpenNewThread) {
      setShowNewThreadBox(true)
    }
  }, [autoOpenNewThread])

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
                <div
                  style={{
                    width: 1,
                    height: 16,
                    background: 'var(--mantine-color-gray-4)',
                  }}
                />
              </>
            )}

            <Button
              size="xs"
              variant="light"
              onClick={() => setShowNewThreadBox(!showNewThreadBox)}
            >
              + New
            </Button>
          </Group>
        </Group>

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
                data-testid="new-thread-textarea"
              />
              <Group gap="xs">
                <Button
                  size="xs"
                  onClick={handleCreateNewThread}
                  loading={isSubmitting}
                  disabled={!newThreadText.trim()}
                  data-testid="create-thread-button"
                >
                  Create Thread
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => {
                    setShowNewThreadBox(false)
                    onCancelNewThread?.()
                  }}
                >
                  Cancel
                </Button>
              </Group>
            </Stack>
          </Paper>
        )}

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
                      width:
                        isActive || sortedThreads.length === 1
                          ? 'calc(100% - 72px)' // Active or single: leave room for peekaboo/spacing
                          : 400, // Non-active: fixed width
                      maxWidth: isActive || sortedThreads.length === 1 ? 'calc(100% - 72px)' : 400,
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

              {/* Without this spacer the last thread right-aligns, showing previous threads on the left. */}
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

        {sortedThreads.length === 0 && !showNewThreadBox && (
          <Text size="xs" c="dimmed" ta="center" py="xs">
            No comments yet. Click &quot;+ New&quot; to start a thread.
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
