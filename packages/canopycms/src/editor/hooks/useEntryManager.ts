import { useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { ListEntriesResponse } from '../../api/entries'
import type { WriteContentBody } from '../../api/content'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { LogicalPath } from '../../paths/types'
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
  handleCreateEntry: (collectionPath: LogicalPath, entryTypeName?: string) => Promise<void>
  renameEntry: (path: string, newSlug: string) => Promise<void>
  loadEntry: (entry: EditorEntry) => Promise<FormValue>
  saveEntry: (entry: EditorEntry, value: FormValue) => Promise<FormValue>
  collectionByPath: Map<LogicalPath, EditorCollection>
  // Entry create modal state
  createModalOpen: boolean
  createModalCollection: EditorCollection | null
  createModalError: string | null
  createModalCreating: boolean
  handleCreateModalSubmit: (slug: string, entryTypeName: string) => Promise<void>
  closeCreateModal: () => void
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
  const [collectionsState, setCollectionsState] = useState<EditorCollection[]>(
    options.collections || [],
  )

  // Initialize with prop value or empty (URL sync happens in effect after mount)
  const [selectedPath, setSelectedPath] = useState<string>(options.initialSelectedId ?? '')
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const isInitialMount = useRef(true)
  const hasSyncedFromUrl = useRef(false)

  // Entry create modal state
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createModalCollection, setCreateModalCollection] = useState<EditorCollection | null>(null)
  const [createModalError, setCreateModalError] = useState<string | null>(null)
  const [createModalCreating, setCreateModalCreating] = useState(false)

  // Store the URL entry param on mount (before any effects change the URL)
  const initialUrlEntry = useRef<string | null>(null)
  if (typeof window !== 'undefined' && initialUrlEntry.current === null) {
    const params = new URLSearchParams(window.location.search)
    initialUrlEntry.current = params.get('entry')
  }

  const collectionByPath = useMemo(() => {
    const map = new Map<LogicalPath, EditorCollection>()
    const walk = (collections: EditorCollection[]) => {
      for (const c of collections) {
        map.set(c.path, c)
        if (c.children) {
          walk(c.children)
        }
      }
    }
    walk(collectionsState)
    return map
  }, [collectionsState])

  const currentEntry = useMemo(
    () => entriesState.find((e) => e.path === selectedPath),
    [entriesState, selectedPath],
  )

  const loadEntry = async (entry: EditorEntry) => {
    if (!entry.collectionPath) {
      throw new Error('Entry missing collectionPath')
    }
    // Build path from collectionPath and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionPath}/${entry.slug}` : entry.collectionPath
    const result = await apiClient.content.read({
      branch: options.branchName,
      path,
    })
    if (!result.ok) throw new Error(`Load failed: ${result.status}`)
    return normalizeContentPayload(result.data)
  }

  const saveEntry = async (entry: EditorEntry, value: FormValue) => {
    if (!entry.collectionPath) {
      throw new Error('Entry missing collectionPath')
    }
    const payload = buildWritePayload(entry, value)
    // Build path from collectionPath and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionPath}/${entry.slug}` : entry.collectionPath
    const result = await apiClient.content.write(
      {
        branch: options.branchName,
        path,
      },
      payload as unknown as WriteContentBody, // buildWritePayload returns the correct shape
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

    // Hydrate wire flatSchema: resolve schemaRef → schema from entrySchemas dict
    const { entrySchemas } = schemaResult.data
    const hydratedFlatSchema = schemaResult.data.flatSchema.map((item) =>
      item.type === 'entry-type' ? { ...item, schema: entrySchemas[item.schemaRef] ?? [] } : item,
    ) as import('../../config').FlatSchemaItem[]

    // Build editor collections from hydrated flatSchema
    // Dynamic import: lazy-load heavier editor config; only needed after API data arrives
    const { buildEditorCollections } = await import('../editor-config')
    const collections = buildEditorCollections(hydratedFlatSchema)
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
      flatSchema: hydratedFlatSchema,
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
   * Open the create entry modal for the specified collection
   */
  const handleCreateEntry = async (collectionPath: LogicalPath, _?: string) => {
    const col = collectionByPath.get(collectionPath)
    if (!col || col.type === 'entry') {
      return
    }

    setCreateModalCollection(col)
    setCreateModalError(null)
    setCreateModalOpen(true)
  }

  /**
   * Handle entry creation from the modal
   */
  const handleCreateModalSubmit = async (slug: string, entryTypeName: string) => {
    if (!createModalCollection) return

    setCreateModalCreating(true)
    setCreateModalError(null)

    try {
      const selectedType = createModalCollection.entryTypes?.find((et) => et.name === entryTypeName)
      const format = selectedType?.format || createModalCollection.format

      const payload =
        format === 'json' ? { format: 'json' as const, data: {} } : { format, data: {}, body: '' }

      // Use collection path (e.g., "content/posts") not name (e.g., "posts")
      const path = `${createModalCollection.path}/${slug}`
      const result = await apiClient.content.write(
        {
          branch: options.branchName,
          path,
          entryType: entryTypeName,
        },
        payload as unknown as WriteContentBody,
      )

      if (!result.ok) {
        const errorMsg = 'error' in result ? result.error : `Create failed: ${result.status}`
        throw new Error(errorMsg)
      }

      await refreshEntries()
      notifications.show({ message: 'Created new entry', color: 'green' })
      setCreateModalOpen(false)
      setCreateModalCollection(null)
    } catch (err) {
      console.error(err)
      const errorMessage = err instanceof Error ? err.message : 'Create failed'
      setCreateModalError(errorMessage)
    } finally {
      setCreateModalCreating(false)
    }
  }

  /**
   * Close the create entry modal
   */
  const closeCreateModal = () => {
    setCreateModalOpen(false)
    setCreateModalCollection(null)
    setCreateModalError(null)
    setCreateModalCreating(false)
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
        { newSlug },
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
      notifications.show({
        message: 'Entry renamed successfully',
        color: 'green',
      })
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
    collectionByPath: collectionByPath,
    createModalOpen,
    createModalCollection,
    createModalError,
    createModalCreating,
    handleCreateModalSubmit,
    closeCreateModal,
  }
}
