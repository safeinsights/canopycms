import { useEffect, useMemo, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { CommentThread } from '../../comment-store'
import type { EditorEntry } from '../Editor'
import { normalizeCanopyPath } from '../canopy-path'
import type { ApiResponse } from '../../api/types'

export interface UseCommentSystemOptions {
  /**
   * Current branch name for loading/saving comments.
   */
  branchName: string

  /**
   * Currently selected entry ID.
   */
  selectedId: string

  /**
   * Current entry being edited.
   */
  currentEntry: EditorEntry | undefined

  /**
   * Current user identifier.
   */
  currentUser: string

  /**
   * Whether the current user can resolve comment threads.
   */
  canResolveComments: boolean

  /**
   * Callback to change the selected entry.
   */
  setSelectedId: (id: string) => void

  /**
   * Callback to open the branch manager.
   */
  setBranchManagerOpen: (open: boolean) => void

  /**
   * Optional callback when comments are loaded/updated.
   */
  onCommentsChange?: (comments: CommentThread[]) => void
}

export interface UseCommentSystemReturn {
  comments: CommentThread[]
  focusedFieldPath: string | undefined
  setFocusedFieldPath: (path: string | undefined) => void
  highlightThreadId: string | undefined
  setHighlightThreadId: (id: string | undefined) => void
  commentsPanelOpen: boolean
  setCommentsPanelOpen: (open: boolean) => void
  commentThreadPanelOpen: boolean
  setCommentThreadPanelOpen: (open: boolean) => void
  activeCommentContext: { type: 'field' | 'entry' | 'branch'; canopyPath?: string } | null
  setActiveCommentContext: (
    context: { type: 'field' | 'entry' | 'branch'; canopyPath?: string } | null
  ) => void
  activeThreads: CommentThread[]
  activeContextLabel: string
  handleAddComment: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryId?: string,
    canopyPath?: string,
    threadId?: string
  ) => Promise<void>
  handleResolveThread: (threadId: string) => Promise<void>
  loadComments: (branch: string) => Promise<void>
  handleJumpToField: (entryId: string, canopyPath: string, threadId: string) => void
  handleJumpToEntry: (entryId: string, threadId: string) => void
  handleJumpToBranch: (threadId: string) => void
}

/**
 * Custom hook for managing the comment system.
 *
 * Handles:
 * - Loading comments from API
 * - Adding comments to threads
 * - Resolving comment threads
 * - Field focus highlighting from preview frame
 * - Active comment context tracking
 *
 * @example
 * ```tsx
 * const {
 *   comments,
 *   activeThreads,
 *   handleAddComment,
 *   handleResolveThread,
 *   loadComments
 * } = useCommentSystem({
 *   branchName,
 *   selectedId,
 *   currentEntry,
 *   currentUser,
 *   canResolveComments,
 *   onReloadBranches
 * })
 * ```
 */
export function useCommentSystem(options: UseCommentSystemOptions): UseCommentSystemReturn {
  const [comments, setComments] = useState<CommentThread[]>([])
  const [focusedFieldPath, setFocusedFieldPath] = useState<string | undefined>(undefined)
  const [highlightThreadId, setHighlightThreadId] = useState<string | undefined>(undefined)
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false)
  const [commentThreadPanelOpen, setCommentThreadPanelOpen] = useState(false)
  const [activeCommentContext, setActiveCommentContext] = useState<{
    type: 'field' | 'entry' | 'branch'
    canopyPath?: string
  } | null>(null)

  const loadComments = async (branch: string) => {
    if (!branch) return
    try {
      const res = await fetch(`/api/canopycms/${branch}/comments`)
      if (!res.ok) {
        console.error('Failed to load comments:', res.status)
        return
      }
      const payload = (await res.json()) as ApiResponse<{ threads: CommentThread[] }>
      const threads = payload.data?.threads ?? []
      setComments(threads)
      options.onCommentsChange?.(threads)
    } catch (err) {
      console.error('Failed to load comments:', err)
    }
  }

  const handleAddComment = async (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryId?: string,
    canopyPath?: string,
    threadId?: string
  ) => {
    if (!options.branchName) return
    try {
      const body: any = { text, threadId, type }

      // Add entryId for field/entry comments
      if (entryId && (type === 'field' || type === 'entry')) {
        body.entryId = entryId
      }

      // Add canopyPath for field comments
      if (canopyPath && type === 'field') {
        body.canopyPath = canopyPath
      }

      const res = await fetch(`/api/canopycms/${options.branchName}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to add comment')
      await loadComments(options.branchName)
      // Branch summaries auto-update via useMemo watching comments
      notifications.show({ message: 'Comment added', color: 'green' })
    } catch (err) {
      notifications.show({ message: 'Failed to add comment', color: 'red' })
    }
  }

  const handleResolveThread = async (threadId: string) => {
    if (!options.branchName) return
    try {
      const res = await fetch(
        `/api/canopycms/${options.branchName}/comments/${threadId}/resolve`,
        {
          method: 'POST',
        }
      )
      if (!res.ok) throw new Error('Failed to resolve thread')
      await loadComments(options.branchName)
      // Branch summaries auto-update via useMemo watching comments
      notifications.show({ message: 'Thread resolved', color: 'green' })
    } catch (err) {
      notifications.show({ message: 'Failed to resolve thread', color: 'red' })
    }
  }

  // Compute active comment threads for the thread panel
  const activeThreads = useMemo(() => {
    if (!activeCommentContext) return []

    if (activeCommentContext.type === 'field' && activeCommentContext.canopyPath) {
      return comments.filter(
        (t) =>
          t.type === 'field' &&
          t.entryId === options.selectedId &&
          t.canopyPath === activeCommentContext.canopyPath
      )
    } else if (activeCommentContext.type === 'entry') {
      return comments.filter((t) => t.type === 'entry' && t.entryId === options.selectedId)
    } else if (activeCommentContext.type === 'branch') {
      return comments.filter((t) => t.type === 'branch')
    }

    return []
  }, [activeCommentContext, comments, options.selectedId])

  const activeContextLabel = useMemo(() => {
    if (!activeCommentContext) return ''

    if (activeCommentContext.type === 'field' && activeCommentContext.canopyPath) {
      return activeCommentContext.canopyPath
    } else if (activeCommentContext.type === 'entry') {
      return options.selectedId
    } else if (activeCommentContext.type === 'branch') {
      return options.branchName
    }

    return ''
  }, [activeCommentContext, options.selectedId, options.branchName])

  // Load comments when branch changes
  useEffect(() => {
    if (options.branchName) {
      loadComments(options.branchName).catch((err) => {
        console.error(err)
      })
    }
  }, [options.branchName])

  // Listen for field focus messages from preview frame
  useEffect(() => {
    const handleFocus = (event: MessageEvent) => {
      const msg = event.data as { type?: string; entryId?: string; fieldPath?: string }
      if (msg?.type !== 'canopycms:preview:focus') return
      if (
        msg.entryId &&
        msg.entryId !== (options.currentEntry?.previewSrc ?? options.currentEntry?.id)
      )
        return
      const normalizedPath = msg.fieldPath ? normalizeCanopyPath(msg.fieldPath) : undefined
      const target = normalizedPath
        ? document.querySelector<HTMLElement>(`[data-canopy-field="${normalizedPath}"]`)
        : null
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const previous = target.style.boxShadow
        target.style.boxShadow = '0 0 0 3px rgba(79, 70, 229, 0.35)'
        window.setTimeout(() => {
          target.style.boxShadow = previous
        }, 1200)

        // Set focused field path to trigger FieldWrapper auto-focus
        if (normalizedPath) {
          setFocusedFieldPath(normalizedPath)
          // Clear after brief delay to allow FieldWrapper to detect the change
          window.setTimeout(() => {
            setFocusedFieldPath(undefined)
          }, 100)
        }
      }
    }
    window.addEventListener('message', handleFocus)
    return () => window.removeEventListener('message', handleFocus)
  }, [options.currentEntry])

  // Jump-to handlers for navigating from CommentsPanel
  const handleJumpToField = (entryId: string, canopyPath: string, threadId: string) => {
    // Switch to the correct entry if needed
    if (entryId !== options.selectedId) {
      options.setSelectedId(entryId)
    }

    // Wait for entry to load, then scroll and highlight
    window.setTimeout(() => {
      // Find and scroll to the field element
      const fieldElement = document.querySelector(`[data-canopy-field="${canopyPath}"]`)
      if (fieldElement) {
        fieldElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      // Set focused field path and highlight thread
      setFocusedFieldPath(canopyPath)
      setHighlightThreadId(threadId)
      window.setTimeout(() => {
        setFocusedFieldPath(undefined)
        setHighlightThreadId(undefined)
      }, 2100) // Clear after highlight animation completes
    }, entryId !== options.selectedId ? 300 : 0) // Delay if switching entries
  }

  const handleJumpToEntry = (entryId: string, threadId: string) => {
    // Switch to the correct entry if needed
    if (entryId !== options.selectedId) {
      options.setSelectedId(entryId)
    }

    // Wait for entry to load, then scroll and highlight
    window.setTimeout(() => {
      // Scroll to top of form (where EntryComments renders)
      const formElement = document.querySelector('[data-form-renderer]')
      if (formElement) {
        formElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      // Set highlight thread
      setHighlightThreadId(threadId)
      window.setTimeout(() => {
        setHighlightThreadId(undefined)
      }, 2100) // Clear after highlight animation completes
    }, entryId !== options.selectedId ? 300 : 0) // Delay if switching entries
  }

  const handleJumpToBranch = (threadId: string) => {
    // Open branch manager and highlight thread
    options.setBranchManagerOpen(true)
    setHighlightThreadId(threadId)
    window.setTimeout(() => {
      setHighlightThreadId(undefined)
    }, 2100) // Clear after highlight animation completes
  }

  return {
    comments,
    focusedFieldPath,
    setFocusedFieldPath,
    highlightThreadId,
    setHighlightThreadId,
    commentsPanelOpen,
    setCommentsPanelOpen,
    commentThreadPanelOpen,
    setCommentThreadPanelOpen,
    activeCommentContext,
    setActiveCommentContext,
    activeThreads,
    activeContextLabel,
    handleAddComment,
    handleResolveThread,
    loadComments,
    handleJumpToField,
    handleJumpToEntry,
    handleJumpToBranch,
  }
}
