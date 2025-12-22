import { useEffect, useMemo, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { ApiResponse } from '../../api/types'
import type { ListEntriesResponse } from '../../api/entries'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { FormValue } from '../FormRenderer'
import {
  buildEntriesFromListResponse,
  buildWritePayload,
  normalizeContentPayload,
} from '../editor-utils'

export interface UseEntryManagerOptions {
  initialEntries: EditorEntry[]
  initialSelectedId?: string
  branchName: string
  collections?: EditorCollection[]
  previewBaseByCollection?: Record<string, string>
  resolvePreviewSrc: (entry: Partial<EditorEntry>) => string | undefined
  setBusy: (busy: boolean) => void
}

export interface UseEntryManagerReturn {
  selectedId: string
  setSelectedId: (id: string) => void
  entries: EditorEntry[]
  setEntries: (entries: EditorEntry[]) => void
  currentEntry: EditorEntry | undefined
  navigatorOpen: boolean
  setNavigatorOpen: (open: boolean) => void
  refreshEntries: (branch?: string) => Promise<void>
  handleCreateEntry: (collectionId: string) => Promise<void>
  loadEntry: (entry: EditorEntry) => Promise<FormValue>
  saveEntry: (entry: EditorEntry, value: FormValue) => Promise<FormValue>
  collectionById: Map<string, EditorCollection>
}

/**
 * Custom hook for managing editor entries (CRUD operations).
 *
 * Handles:
 * - Entry selection and navigation
 * - Loading and saving entry data
 * - Refreshing entry list from API
 * - Creating new entries
 * - URL synchronization for selected entry
 *
 * @example
 * ```tsx
 * const {
 *   selectedId,
 *   entries,
 *   currentEntry,
 *   refreshEntries,
 *   handleCreateEntry,
 *   loadEntry,
 *   saveEntry
 * } = useEntryManager({
 *   initialEntries: entries,
 *   branchName,
 *   collections,
 *   resolvePreviewSrc,
 *   setBusy
 * })
 * ```
 */
export function useEntryManager(options: UseEntryManagerOptions): UseEntryManagerReturn {
  const [entriesState, setEntriesState] = useState<EditorEntry[]>(options.initialEntries)
  const [selectedId, setSelectedId] = useState<string>(
    options.initialSelectedId ?? entriesState[0]?.id ?? '',
  )
  const [navigatorOpen, setNavigatorOpen] = useState(false)

  const collectionById = useMemo(() => {
    const map = new Map<string, EditorCollection>()
    if (!options.collections) return map
    const walk = (collections: EditorCollection[]) => {
      for (const c of collections) {
        map.set(c.name, c)
        if (c.children) {
          walk(c.children)
        }
      }
    }
    walk(options.collections)
    return map
  }, [options.collections])

  const currentEntry = useMemo(
    () => entriesState.find((e) => e.id === selectedId),
    [entriesState, selectedId],
  )

  const loadEntry = async (entry: EditorEntry) => {
    const res = await fetch(entry.apiPath)
    if (!res.ok) throw new Error(`Load failed: ${res.status}`)
    const payload = (await res.json()) as ApiResponse
    const content = 'data' in payload ? (payload as ApiResponse).data : payload
    return normalizeContentPayload(content)
  }

  const saveEntry = async (entry: EditorEntry, value: FormValue) => {
    const res = await fetch(entry.apiPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWritePayload(entry, value)),
    })
    if (!res.ok) throw new Error(`Save failed: ${res.status}`)
    const payload = (await res.json()) as ApiResponse
    const content = 'data' in payload ? (payload as ApiResponse).data : payload
    return normalizeContentPayload(content)
  }

  const refreshEntries = async (branch: string = options.branchName) => {
    if (!branch) return
    const res = await fetch(`/api/canopycms/${branch}/entries`)
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`)
    const payload = (await res.json()) as ApiResponse<ListEntriesResponse>
    const data = ('data' in payload ? payload.data : payload) as ListEntriesResponse
    const refreshed = buildEntriesFromListResponse({
      response: data,
      branchName: branch,
      resolvePreviewSrc: (entry) => options.resolvePreviewSrc(entry) ?? '',
      existingEntries: entriesState,
      currentEntry,
      initialEntries: options.initialEntries,
    })
    setEntriesState(refreshed)
    const newlyCreated = refreshed.find((e) => !entriesState.find((old) => old.id === e.id))
    if (newlyCreated) {
      setSelectedId(newlyCreated.id)
    }
  }

  const handleCreateEntry = async (collectionId: string) => {
    const col = collectionById.get(collectionId)
    if (!col || col.type === 'singleton') return
    const slug = window.prompt(`New ${col.label ?? col.name} slug?`, 'untitled')
    if (!slug) return
    options.setBusy(true)
    try {
      const payload =
        col.format === 'json'
          ? { collection: collectionId, slug, format: 'json' as const, data: {} }
          : { collection: collectionId, slug, format: col.format, data: {}, body: '' }
      const res = await fetch(
        `/api/canopycms/${options.branchName}/content/${encodeURIComponent(collectionId)}/${encodeURIComponent(slug)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) throw new Error(`Create failed: ${res.status}`)
      await refreshEntries()
      notifications.show({ message: 'Created new entry', color: 'green' })
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Create failed', color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  // Validate selected entry when entries change
  useEffect(() => {
    if (!entriesState.find((e) => e.id === selectedId)) {
      setSelectedId(entriesState[0]?.id ?? '')
    }
  }, [entriesState, selectedId])

  // Sync entry selection with URL parameter
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const entryParam = params.get('entry')
    if (entryParam && entriesState.find((e) => e.id === entryParam)) {
      setSelectedId(entryParam)
    }
  }, [entriesState])

  // Update URL when selection changes
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (selectedId) {
      url.searchParams.set('entry', selectedId)
    } else {
      url.searchParams.delete('entry')
    }
    window.history.replaceState({}, '', url.toString())
  }, [selectedId])

  return {
    selectedId,
    setSelectedId,
    entries: entriesState,
    setEntries: setEntriesState,
    currentEntry,
    navigatorOpen,
    setNavigatorOpen,
    refreshEntries,
    handleCreateEntry,
    loadEntry,
    saveEntry,
    collectionById,
  }
}
