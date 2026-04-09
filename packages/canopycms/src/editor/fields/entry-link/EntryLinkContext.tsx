/**
 * React context for providing entry data to the InsertEntryLink toolbar button.
 *
 * The MarkdownField is lazy-loaded and its toolbar components don't have direct
 * access to the editor's entry list. This context bridges that gap.
 */

import { createContext, useContext } from 'react'
import type { ContentId, LogicalPath } from '../../../paths/types'

export interface EntryLinkOption {
  contentId: ContentId
  label: string
  slug?: string
  collectionPath?: LogicalPath
  collectionName?: string
}

export interface EntryLinkContextValue {
  entries: EntryLinkOption[]
}

export const EntryLinkContext = createContext<EntryLinkContextValue>({ entries: [] })

export function useEntryLinkContext(): EntryLinkContextValue {
  return useContext(EntryLinkContext)
}
