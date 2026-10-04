'use client'

/**
 * Bridges entry data to MarkdownField's lazy-loaded toolbar components (e.g.
 * InsertEntryLink), which have no direct access to the editor's entry list.
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
