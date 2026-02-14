import { useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { ListEntriesResponse } from '../../api/entries'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { FormValue } from '../FormRenderer'
import {
  buildEntriesFromListResponse,
  buildWritePayload,
  normalizeContentPayload,
} from '../editor-utils'
import { useApiClient } from '../context'

export interface UseEntryManagerOptions {
  initialEntries: EditorEntry[]
  initialSelectedId?: string
  branchName: string
  collections?: EditorCollection[]
  previewBaseByCollection?: Record<string, string>
  resolvePreviewSrc: (entry: Partial<EditorEntry>) => string | undefined
  setBusy: (busy: boolean) => void
  contentRoot?: string
}

export interface UseEntryManagerReturn {
  selectedPath: string
  setSelectedPath: (path: string) => void
  entries: EditorEntry[]
  setEntries: (entries: EditorEntry[]) => void
  collections: EditorCollection[]
  currentEntry: EditorEntry | undefined
  navigatorOpen: boolean
  setNavigatorOpen: (open: boolean) => void
  refreshEntries: (branch?: string) => Promise<void>
  handleCreateEntry: (collectionId: string, entryTypeName?: string) => Promise<void>
  renameEntry: (path: string, newSlug: string) => Promise<void>
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
 *   selectedPath,
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
  const apiClient = useApiClient()
  const [entriesState, setEntriesState] = useState<EditorEntry[]>(options.initialEntries)
  const [collectionsState, setCollectionsState] = useState<EditorCollection[]>(options.collections || [])

  // Initialize with prop value or empty (URL sync happens in effect after mount)
  const [selectedPath, setSelectedPath] = useState<string>(options.initialSelectedId ?? '')
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const isInitialMount = useRef(true)
  const hasSyncedFromUrl = useRef(false)

  // Store the URL entry param on mount (before any effects change the URL)
  const initialUrlEntry = useRef<string | null>(null)
  if (typeof window !== 'undefined' && initialUrlEntry.current === null) {
    const params = new URLSearchParams(window.location.search)
    initialUrlEntry.current = params.get('entry')
  }

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
    () => entriesState.find((e) => e.path === selectedPath),
    [entriesState, selectedPath]
  )

  const loadEntry = async (entry: EditorEntry) => {
    if (!entry.collectionId) {
      throw new Error('Entry missing collectionId')
    }
    // Build path from collectionId and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionId}/${entry.slug}` : entry.collectionId
    const result = await apiClient.content.read({
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
    const result = await apiClient.content.write(
      {
        branch: options.branchName,
        path,
      },
      payload as any // buildWritePayload returns the correct shape
    )
    if (!result.ok) throw new Error(`Save failed: ${result.status}`)
    return normalizeContentPayload(result.data)
  }

  const refreshEntries = async (branch: string = options.branchName) => {
    if (!branch) return

    // Fetch schema from schema API
    const schemaResult = await apiClient.schema.get({ branch })
    if (!schemaResult.ok || !schemaResult.data) {
      throw new Error(`Schema fetch failed: ${schemaResult.status}`)
    }

    // Convert schema tree to editor collections
    const { convertSchemaTreeToEditorCollections } = await import('../editor-utils')
    const collections = convertSchemaTreeToEditorCollections(
      schemaResult.data.schema,
      options.contentRoot || 'content'
    )
    setCollectionsState(collections)

    // Fetch entries from entries API
    const result = await apiClient.entries.list({ branch })
    if (!result.ok) throw new Error(`Refresh failed: ${result.status}`)
    const data = result.data as ListEntriesResponse

    // Build entries with resolved schemas from flatSchema
    const refreshed = buildEntriesFromListResponse({
      response: data,
      branchName: branch,
      resolvePreviewSrc: (entry) => options.resolvePreviewSrc(entry) ?? '',
      contentRoot: options.contentRoot || 'content',
      flatSchema: schemaResult.data.flatSchema,
    })

    setEntriesState(refreshed)

    // Only auto-select newly created entry if there were already entries before
    if (entriesState.length > 0) {
      const newlyCreated = refreshed.find((e) => !entriesState.find((old) => old.path === e.path))
      if (newlyCreated) {
        setSelectedPath(newlyCreated.path)
      }
    }
  }

  /**
   * Create a new entry in a collection.
   * @param collectionId - The collection's logical path
   * @param entryTypeName - Optional entry type name. If not provided and collection has multiple types,
   *                        uses the default type or prompts user to select one.
   */
  const handleCreateEntry = async (collectionId: string, entryTypeName?: string) => {
    const col = collectionById.get(collectionId)
    if (!col || col.type === 'entry') {
      console.log('Collection not found or is root entry type:', { collectionId })
      return
    }

    // Determine which entry type to use
    const entryTypes = col.entryTypes || []
    let selectedType = entryTypes.find(et => et.name === entryTypeName)

    if (!selectedType && entryTypes.length > 1) {
      // Multiple types available, prompt user to select
      const typeOptions = entryTypes.map((et, i) => `${i + 1}. ${et.label || et.name}`).join('\n')
      const selection = window.prompt(
        `Select entry type:\n${typeOptions}\n\nEnter number (1-${entryTypes.length}):`,
        '1'
      )
      if (!selection) return
      const index = parseInt(selection, 10) - 1
      if (index >= 0 && index < entryTypes.length) {
        selectedType = entryTypes[index]
      } else {
        notifications.show({ message: 'Invalid selection', color: 'red' })
        return
      }
    } else if (!selectedType && entryTypes.length === 1) {
      // Single type, use it
      selectedType = entryTypes[0]
    }

    // Fall back to collection's format if no entry types defined
    const format = selectedType?.format || col.format

    const slug = window.prompt(`New ${selectedType?.label || col.label || col.name} slug?`, 'untitled')
    if (!slug) return
    options.setBusy(true)
    try {
      const payload =
        format === 'json'
          ? { format: 'json' as const, data: {} }
          : { format, data: {}, body: '' }
      const path = `${collectionId}/${slug}`
      const result = await apiClient.content.write(
        {
          branch: options.branchName,
          path,
        },
        payload as any
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

  /**
   * Rename an entry's slug
   */
  const renameEntry = async (path: string, newSlug: string): Promise<void> => {
    options.setBusy(true)
    try {
      const result = await apiClient.content.renameEntry(
        {
          branch: options.branchName,
          path,
        },
        { newSlug }
      )
      if (!result.ok) {
        const errorMsg = 'error' in result ? result.error : `Rename failed: ${result.status}`
        throw new Error(errorMsg)
      }

      // Update the selected path if the renamed entry is currently selected
      if (selectedPath === path && result.data) {
        setSelectedPath(result.data.newPath)
      }

      // Refresh entries to get updated paths
      await refreshEntries()
      notifications.show({ message: 'Entry renamed successfully', color: 'green' })
    } catch (err) {
      console.error(err)
      const errorMessage = err instanceof Error ? err.message : 'Rename failed'
      notifications.show({ message: errorMessage, color: 'red' })
      throw err
    } finally {
      options.setBusy(false)
    }
  }

  // Clear selection and refresh entries when branch changes (reactive pattern)
  useEffect(() => {
    if (options.branchName) {
      // On initial mount, preserve the initial selection from URL
      // On subsequent branch changes, clear selection
      if (isInitialMount.current) {
        isInitialMount.current = false
      } else {
        setSelectedPath('')
      }

      // Refresh entries for new branch
      options.setBusy(true)
      refreshEntries(options.branchName)
        .catch(console.error)
        .finally(() => options.setBusy(false))
    }
  }, [options.branchName])

  // Validate selected entry when entries change
  useEffect(() => {
    // Skip validation if entries haven't loaded yet
    if (entriesState.length === 0) return

    // On first load with entries, sync from URL if we haven't already
    if (!hasSyncedFromUrl.current) {
      hasSyncedFromUrl.current = true
      // If there's an entry in the URL that exists in entries, select it
      if (initialUrlEntry.current && entriesState.find((e) => e.path === initialUrlEntry.current)) {
        setSelectedPath(initialUrlEntry.current!)
        return
      }
    }

    // If the selected entry exists, keep it
    if (entriesState.find((e) => e.path === selectedPath)) return

    // Fall back to first entry
    setSelectedPath(entriesState[0]?.path ?? '')
  }, [entriesState, selectedPath])

  // Update URL when selection changes (skip until URL sync has happened)
  useEffect(() => {
    if (typeof window === 'undefined') return
    // Don't update URL until we've synced from it first
    if (!hasSyncedFromUrl.current) return
    const url = new URL(window.location.href)
    if (selectedPath) {
      url.searchParams.set('entry', selectedPath)
    } else {
      url.searchParams.delete('entry')
    }
    window.history.replaceState({}, '', url.toString())
  }, [selectedPath])

  return {
    selectedPath,
    setSelectedPath,
    entries: entriesState,
    setEntries: setEntriesState,
    collections: collectionsState,
    currentEntry,
    navigatorOpen,
    setNavigatorOpen,
    refreshEntries,
    handleCreateEntry,
    renameEntry,
    loadEntry,
    saveEntry,
    collectionById,
  }
}
