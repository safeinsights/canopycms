import { useEffect, useMemo, useState } from 'react'
import { useSWRConfig } from 'swr'
import type { CommentThread } from '../../comment-store'
import type { UserSearchResult } from '../../auth/types'
import type { EditorEntry } from '../Editor'
import { findFieldTarget, whenRevealed } from '../field-target'
import { useApiClient } from '../context'
import { isGatewayFailure, isUnanswered, MayHaveLandedError } from '../unanswered'
import { resolveMessageOrigin } from '../preview-bridge'
import { isSamePreviewPath } from '../preview-path'
import { commentsKey, fetchCommentsSeedingUsers, useCommentsData } from './useCommentsData'
import { useSeededUserResolver } from './useUserMetadata'

export interface UseCommentSystemOptions {
  branchName: string

  selectedPath: string

  currentEntry: EditorEntry | undefined

  currentUser: string

  canResolveComments: boolean

  setSelectedPath: (id: string) => void

  setBranchManagerOpen: (open: boolean) => void

  /** Uncovers the form before anything here focuses one of its fields. */
  onRevealForm?: () => void

  onCommentsChange?: (comments: CommentThread[]) => void
}

export interface UseCommentSystemReturn {
  comments: CommentThread[]
  /** Resolves a user from the seeded cache, without email or a request (`useSeededUserResolver`). */
  getCommentUser: (userId: string) => Promise<UserSearchResult | null>
  focusedFieldPath: string | undefined
  setFocusedFieldPath: (path: string | undefined) => void
  highlightThreadId: string | undefined
  setHighlightThreadId: (id: string | undefined) => void
  commentsPanelOpen: boolean
  setCommentsPanelOpen: (open: boolean) => void
  commentThreadPanelOpen: boolean
  setCommentThreadPanelOpen: (open: boolean) => void
  activeCommentContext: {
    type: 'field' | 'entry' | 'branch'
    canopyPath?: string
  } | null
  setActiveCommentContext: (
    context: { type: 'field' | 'entry' | 'branch'; canopyPath?: string } | null,
  ) => void
  activeThreads: CommentThread[]
  activeContextLabel: string
  /** `itemKeys`: for a new field thread, the keys of the list items on `canopyPath`. */
  handleAddComment: (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryPath?: string,
    canopyPath?: string,
    threadId?: string,
    itemKeys?: string[],
  ) => Promise<void>
  handleResolveThread: (threadId: string) => Promise<void>
  loadComments: (branch: string) => Promise<CommentThread[] | undefined>
  handleJumpToField: (entryPath: string, canopyPath: string, threadId: string) => void
  handleJumpToEntry: (entryPath: string, threadId: string) => void
  handleJumpToBranch: (threadId: string) => void
}

/** @internal Exported for tests. */
export const COMMENT_NOT_ADDED = "Couldn't add the comment. Try again."
/** @internal Exported for tests. */
export const COMMENT_MAY_BE_ADDED =
  "The server didn't answer, and the comments don't show yours yet, but it may still be posted. Wait a moment and check before sending it again."
/** @internal Exported for tests. */
export const THREAD_NOT_RESOLVED = "Couldn't resolve the thread. Try again."

/**
 * Custom hook for managing the comment system.
 */
export function useCommentSystem(options: UseCommentSystemOptions): UseCommentSystemReturn {
  const apiClient = useApiClient()
  const { cache, mutate: globalMutate } = useSWRConfig()
  const [focusedFieldPath, setFocusedFieldPath] = useState<string | undefined>(undefined)
  const [highlightThreadId, setHighlightThreadId] = useState<string | undefined>(undefined)
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false)
  const [commentThreadPanelOpen, setCommentThreadPanelOpen] = useState(false)
  const [activeCommentContext, setActiveCommentContext] = useState<{
    type: 'field' | 'entry' | 'branch'
    canopyPath?: string
  } | null>(null)

  // Automatic load, keyed per branch and deduped by SWR (e.g. React Strict
  // Mode's double effect invoke collapses to a single request). Switching
  // branches re-keys automatically, so no manual branch-change effect is
  // needed.
  const { data: commentsData, error: commentsError } = useCommentsData(
    apiClient,
    options.branchName,
  )
  const comments = commentsData?.threads ?? []
  const getCommentUser = useSeededUserResolver()

  // Deliberately omits `options.onCommentsChange` from the deps: it's a
  // stable setState passthrough, and this file is plain .ts (not .tsx), so
  // the react-hooks/exhaustive-deps rule isn't active here anyway --
  // including it would refire this on every Editor.tsx render regardless.
  // A branch whose comments never loaded reports none, not the previous branch's.
  useEffect(() => {
    if (commentsData) options.onCommentsChange?.(commentsData.threads)
    else if (commentsError) options.onCommentsChange?.([])
  }, [commentsData, commentsError])

  // Explicit reload: always issues a fresh, independent fetch (raw call, not
  // SWR's `mutate()` revalidate path) so a caller requesting a reload right
  // after mount isn't coalesced against the still-in-flight automatic load
  // -- then writes the result into the shared cache so useCommentsData's
  // bound hook (and the effect above) pick it up.
  // A failed reload logs and keeps the threads already shown. Resolves to the reloaded threads.
  const loadComments = async (branch: string): Promise<CommentThread[] | undefined> => {
    if (!branch) return undefined
    let fresh: Awaited<ReturnType<typeof fetchCommentsSeedingUsers>>
    try {
      fresh = await fetchCommentsSeedingUsers(apiClient, { cache, mutate: globalMutate }, branch)
    } catch (err) {
      console.error('Failed to load comments:', err)
      return undefined
    }
    await globalMutate(commentsKey(branch), fresh, { revalidate: false })
    return fresh.threads
  }

  // Both reject on failure, so the caller keeps the person's text and shows the error where they
  // wrote it. Success shows itself in the thread, so it has no toast.
  const handleAddComment = async (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryPath?: string,
    canopyPath?: string,
    threadId?: string,
    itemKeys?: string[],
  ) => {
    const branch = options.branchName
    if (!branch) return
    // What was on screen at send, so only a comment that is new since can count as this one.
    const loaded = commentsData !== undefined
    const shownComments = new Set(comments.flatMap((t) => t.comments.map((c) => c.id)))
    const isThis = (c: { id: string; userId: string; text: string }) =>
      !shownComments.has(c.id) && c.userId === options.currentUser && c.text === text
    const result = await apiClient.comments
      .add({ branch }, { text, threadId, type, entryPath, canopyPath, itemKeys })
      .catch((err: unknown) => (isUnanswered(err) ? 'unanswered' : null))
    if (result === 'unanswered' || (result && isGatewayFailure(result))) {
      // Landed, it is a new comment of theirs: in the thread replied to, or opening one here.
      const reloaded = await loadComments(branch)
      const posted =
        loaded &&
        reloaded?.some((t) =>
          threadId
            ? t.id === threadId && t.comments.some(isThis)
            : t.type === type &&
              t.entryPath === entryPath &&
              t.canopyPath === canopyPath &&
              t.comments[0] !== undefined &&
              isThis(t.comments[0]),
        )
      if (posted) return
      throw new MayHaveLandedError(COMMENT_MAY_BE_ADDED)
    }
    if (!result?.ok) throw new Error(COMMENT_NOT_ADDED)
    await loadComments(branch)
  }

  const handleResolveThread = async (threadId: string) => {
    if (!options.branchName) return
    const result = await apiClient.comments
      .resolve({ branch: options.branchName, threadId })
      .catch(() => null)
    if (!result?.ok) throw new Error(THREAD_NOT_RESOLVED)
    await loadComments(options.branchName)
  }

  // Compute active comment threads for the thread panel
  const activeThreads = useMemo(() => {
    if (!activeCommentContext) return []

    if (activeCommentContext.type === 'field' && activeCommentContext.canopyPath) {
      return comments.filter(
        (t) =>
          t.type === 'field' &&
          t.entryPath === options.selectedPath &&
          t.canopyPath === activeCommentContext.canopyPath &&
          !t.onRemovedItem,
      )
    } else if (activeCommentContext.type === 'entry') {
      return comments.filter((t) => t.type === 'entry' && t.entryPath === options.selectedPath)
    } else if (activeCommentContext.type === 'branch') {
      return comments.filter((t) => t.type === 'branch')
    }

    return []
  }, [activeCommentContext, comments, options.selectedPath])

  const activeContextLabel = useMemo(() => {
    if (!activeCommentContext) return ''

    if (activeCommentContext.type === 'field' && activeCommentContext.canopyPath) {
      return activeCommentContext.canopyPath
    } else if (activeCommentContext.type === 'entry') {
      return options.selectedPath
    } else if (activeCommentContext.type === 'branch') {
      return options.branchName
    }

    return ''
  }, [activeCommentContext, options.selectedPath, options.branchName])

  // Listen for field focus messages from preview frame
  useEffect(() => {
    // Delayed undo steps (highlight restore, focus clear). Cleanup runs them early rather than
    // dropping them, so an entry switch never leaves a field highlighted or focused.
    const pending = new Map<number, () => void>()
    const later = (undo: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        pending.delete(id)
        undo()
      }, ms)
      pending.set(id, undo)
    }
    const handleFocus = (event: MessageEvent) => {
      // Only accept messages from the preview's origin (same-origin when previewSrc is
      // relative). Origin-only by design: this hook has no handle on the preview iframe
      // for a source check, and the message can at most scroll/focus a form field.
      if (event.origin !== resolveMessageOrigin(options.currentEntry?.previewSrc)) return
      const msg = event.data as {
        type?: string
        entryPath?: string
        fieldPath?: string
      }
      if (msg?.type !== 'canopycms:preview:focus') return
      const currentPath = options.currentEntry?.previewSrc ?? options.currentEntry?.path
      if (
        msg.entryPath &&
        (typeof msg.entryPath !== 'string' ||
          currentPath === undefined ||
          !isSamePreviewPath(msg.entryPath, currentPath))
      )
        return
      const found = typeof msg.fieldPath === 'string' ? findFieldTarget(msg.fieldPath) : undefined
      if (found) {
        const target = found.element
        whenRevealed(target, () => target.scrollIntoView({ behavior: 'smooth', block: 'center' }))
        const previous = target.style.boxShadow
        target.style.boxShadow = '0 0 0 3px rgba(79, 70, 229, 0.35)'
        later(() => {
          target.style.boxShadow = previous
        }, 1200)

        options.onRevealForm?.()
        // Cleared shortly after, once FieldWrapper has seen it and scrolled to the field.
        setFocusedFieldPath(found.path)
        later(() => setFocusedFieldPath(undefined), 100)
      }
    }
    window.addEventListener('message', handleFocus)
    return () => {
      window.removeEventListener('message', handleFocus)
      for (const [id, undo] of pending) {
        window.clearTimeout(id)
        undo()
      }
      pending.clear()
    }
  }, [options.currentEntry])

  const handleJumpToField = (entryPath: string, canopyPath: string, threadId: string) => {
    if (entryPath !== options.selectedPath) {
      options.setSelectedPath(entryPath)
    }

    window.setTimeout(
      () => {
        const target = findFieldTarget(canopyPath)?.element
        if (target) {
          whenRevealed(target, () => target.scrollIntoView({ behavior: 'smooth', block: 'center' }))
        }
        options.onRevealForm?.()
        setFocusedFieldPath(canopyPath)
        setHighlightThreadId(threadId)
        window.setTimeout(() => {
          setFocusedFieldPath(undefined)
          setHighlightThreadId(undefined)
        }, 2100) // Clear after highlight animation completes
      },
      entryPath !== options.selectedPath ? 300 : 0,
    ) // Delay if switching entries
  }

  const handleJumpToEntry = (entryPath: string, threadId: string) => {
    if (entryPath !== options.selectedPath) {
      options.setSelectedPath(entryPath)
    }

    window.setTimeout(
      () => {
        // Scroll to top of form (where EntryComments renders)
        const formElement = document.querySelector('[data-form-renderer]')
        if (formElement) {
          formElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
        options.onRevealForm?.()
        setHighlightThreadId(threadId)
        window.setTimeout(() => {
          setHighlightThreadId(undefined)
        }, 2100) // Clear after highlight animation completes
      },
      entryPath !== options.selectedPath ? 300 : 0,
    ) // Delay if switching entries
  }

  const handleJumpToBranch = (threadId: string) => {
    options.setBranchManagerOpen(true)
    setHighlightThreadId(threadId)
    window.setTimeout(() => {
      setHighlightThreadId(undefined)
    }, 2100) // Clear after highlight animation completes
  }

  return {
    comments,
    getCommentUser,
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
