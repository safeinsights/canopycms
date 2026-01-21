import { createContext, useContext } from 'react'
import type { CommentThread } from '../../comment-store'
import type { EditorEntry } from '../Editor'

/**
 * EditorContext provides shared state for deeply nested components
 * to avoid prop drilling through 5+ component levels.
 *
 * Contains:
 * - Core navigation state (branchName, selectedPath, currentEntry)
 * - Global busy state
 * - Comment system state (for FormRenderer, FieldWrapper, CommentsPanel)
 * - User context for permissions
 */
export interface EditorContextValue {
  // Core navigation (used by 5+ components)
  branchName: string
  selectedPath: string
  currentEntry: EditorEntry | undefined
  busy: boolean

  // Comments (used by FormRenderer, FieldWrapper, CommentsPanel)
  comments: CommentThread[]
  focusedFieldPath: string | undefined
  highlightThreadId: string | undefined

  // User context
  currentUser: string
  canResolveComments: boolean
}

export const EditorContext = createContext<EditorContextValue | undefined>(undefined)

/**
 * Hook to access EditorContext.
 * Throws an error if used outside of EditorContext.Provider.
 *
 * @example
 * ```tsx
 * const { branchName, selectedPath, currentEntry } = useEditorContext()
 * ```
 */
export function useEditorContext(): EditorContextValue {
  const context = useContext(EditorContext)
  if (context === undefined) {
    throw new Error('useEditorContext must be used within EditorContext.Provider')
  }
  return context
}
