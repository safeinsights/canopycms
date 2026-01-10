import { useEffect, useMemo, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { ListEntriesResponse } from '../../api/entries'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { FormValue } from '../FormRenderer'
import {
  buildEntriesFromListResponse,
  buildWritePayload,
  normalizeContentPayload,
} from '../editor-utils'
import { createApiClient } from '../../api'

// Lazy singleton - created on first access to pick up any fetch mocks in tests
let apiClient: ReturnType<typeof createApiClient> | null = null
function getApiClient() {
  if (!apiClient) {
    apiClient = createApiClient()
  }
  return apiClient
}

// For testing: reset the singleton to pick up new fetch mocks
export function resetApiClient() {
  apiClient = null
}

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
    if (!entry.collectionId) {
      throw new Error('Entry missing collectionId')
    }
    // Build path from collectionId and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionId}/${entry.slug}` : entry.collectionId
    const result = await getApiClient().content.read({
      branch: options.branchName,
      path,
    })
    if (!result.ok) throw new Error(`Load failed: ${result.status}`)
    return normalizeContentPayload(result.data)
  }

  const saveEntry = async (entry: EditorEntry, value: FormValue) => {
    if (!entry.collectionId) {
      throw new Error('Entry missing collectionId')
    }
    const payload = buildWritePayload(entry, value)
    // Build path from collectionId and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionId}/${entry.slug}` : entry.collectionId
    const result = await getApiClient().content.write(
      {
        branch: options.branchName,
        path,
      },
      payload as any, // buildWritePayload returns the correct shape
    )
    if (!result.ok) throw new Error(`Save failed: ${result.status}`)
    return normalizeContentPayload(result.data)
  }

  const refreshEntries = async (branch: string = options.branchName) => {
    if (!branch) return
    const result = await getApiClient().entries.list({ branch })
    if (!result.ok) throw new Error(`Refresh failed: ${result.status}`)
    const data = result.data as ListEntriesResponse
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
    if (!col || col.type === 'entry') {
      console.log('Collection not found or is singleton:', { collectionId })
      return
    }
    const slug = window.prompt(`New ${col.label ?? col.name} slug?`, 'untitled')
    if (!slug) return
    options.setBusy(true)
    try {
      const payload =
        col.format === 'json'
          ? { format: 'json' as const, data: {} }
          : { format: col.format, data: {}, body: '' }
      const path = `${collectionId}/${slug}`
      const result = await getApiClient().content.write(
        {
          branch: options.branchName,
          path,
        },
        payload as any,
      )
      if (!result.ok) throw new Error(`Create failed: ${result.status}`)
      await refreshEntries()
      notifications.show({ message: 'Created new entry', color: 'green' })
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Create failed', color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  // Clear selection and refresh entries when branch changes (reactive pattern)
  useEffect(() => {
    if (options.branchName) {
      // Clear selection when branch changes
      setSelectedId('')

      // Refresh entries for new branch
      options.setBusy(true)
      refreshEntries(options.branchName)
        .catch(console.error)
        .finally(() => options.setBusy(false))
    }
  }, [options.branchName])

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
