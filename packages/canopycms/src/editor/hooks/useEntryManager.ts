import { useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { MAX_ENTRIES_PER_PAGE } from '../../api/entries-constants'
import type { CollectionItem, ListEntriesResponse } from '../../api/entries'
import type { WriteContentBody } from '../../api/content'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { LogicalPath } from '../../paths/types'
import type { FormValue } from '../FormRenderer'
import {
  buildEntriesFromListResponse,
  buildWritePayload,
  normalizeContentPayload,
} from '../editor-utils'
import { isDataOnlyFormat } from '../../utils/format'
import type { EntryFieldError } from '../../validation/entry-validator'
import { useApiClient, type ApiClient } from '../context'

/**
 * Thrown by saveEntry when the API returns a non-200 response. Carries the
 * HTTP status so callers can distinguish conflict (409) and validation
 * rejection (422) from other errors, plus the server's structured per-field
 * errors (when present) so the form can surface them next to the fields.
 */
export class SaveApiError extends Error {
  constructor(
    public readonly status: number,
    serverMessage?: string,
    public readonly fieldErrors?: EntryFieldError[],
  ) {
    super(serverMessage || `Save failed: ${status}`)
    this.name = 'SaveApiError'
  }
}

/** Page size for entry list requests — the server's per-page cap, imported to avoid drift. */
const ENTRIES_PAGE_LIMIT = MAX_ENTRIES_PER_PAGE
/** Safety cap on pagination: 50 pages x 200 = 10,000 entries. */
const MAX_ENTRY_PAGES = 50

/**
 * Fetch every entry on a branch by following the list endpoint's pagination
 * cursor. Deduped by logicalPath: the cursor is offset-based, so an item can
 * repeat across pages if content changes between requests.
 *
 * Exported for direct unit testing.
 */
export async function listAllEntries(
  apiClient: { entries: Pick<ApiClient['entries'], 'list'> },
  branch: string,
): Promise<{ entries: CollectionItem[]; truncated: boolean }> {
  const byPath = new Map<string, CollectionItem>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_ENTRY_PAGES; page++) {
    const result = await apiClient.entries.list({
      branch,
      limit: String(ENTRIES_PAGE_LIMIT),
      ...(cursor !== undefined ? { cursor } : {}),
    })
    if (!result.ok || !result.data) throw new Error(`Refresh failed: ${result.status}`)
    const data = result.data as ListEntriesResponse
    for (const entry of data.entries) byPath.set(entry.logicalPath, entry)
    if (!data.pagination?.hasMore || !data.pagination.cursor) {
      return { entries: [...byPath.values()], truncated: false }
    }
    cursor = data.pagination.cursor
  }
  return { entries: [...byPath.values()], truncated: true }
}

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
  /** True while the first entry load for the current branch is in flight (initial load, per branch). */
  entriesInitializing: boolean
  navigatorOpen: boolean
  setNavigatorOpen: (open: boolean) => void
  refreshEntries: (branch?: string) => Promise<EditorEntry[]>
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
  // True while the first entry load for the current branch is in flight. Seeded from the
  // initial branch so it is already true on the first render (before the load effect runs),
  // which lets the empty editor pane / navigator show "Loading…" instead of briefly flashing
  // "Select an item…" / "No content". Reset per branch and cleared when the load settles, so a
  // genuinely empty branch falls back to the normal empty state rather than a stuck loader.
  // Distinct from the shared `setBusy` flag, which also covers saves/renames once content loads.
  const [entriesInitializing, setEntriesInitializing] = useState<boolean>(() =>
    Boolean(options.branchName),
  )

  // Initialize with prop value or empty (URL sync happens in effect after mount)
  const [selectedPath, setSelectedPath] = useState<string>(options.initialSelectedId ?? '')
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const isInitialMount = useRef(true)
  const hasSyncedFromUrl = useRef(false)
  // OCC version tokens keyed by contentId — captured on load, sent on save
  const entryVersionsRef = useRef<Map<string, number>>(new Map())
  // Monotonic token so a stale refresh (e.g. superseded by a branch switch) doesn't commit state
  const refreshSeqRef = useRef(0)
  // Separate token for the branch-change load below: a superseded load's `.finally`
  // must not clear the loading flags while the newer branch is still loading.
  const branchLoadSeqRef = useRef(0)

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
    // Capture OCC version token for next save
    if (entry.contentId && typeof result.data?.version === 'number') {
      entryVersionsRef.current.set(entry.contentId, result.data.version)
    }
    return normalizeContentPayload(result.data)
  }

  const saveEntry = async (entry: EditorEntry, value: FormValue) => {
    if (!entry.collectionPath) {
      throw new Error('Entry missing collectionPath')
    }
    const payload = buildWritePayload(entry, value)
    // Build path from collectionPath and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionPath}/${entry.slug}` : entry.collectionPath
    const writeParams: { branch: string; path: string; entryType?: string } = {
      branch: options.branchName,
      path,
    }
    if (entry.entryType) writeParams.entryType = entry.entryType
    const expectedVersion = entry.contentId
      ? entryVersionsRef.current.get(entry.contentId)
      : undefined
    const writeBody: WriteContentBody = {
      ...(payload as unknown as WriteContentBody),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    }
    const result = await apiClient.content.write(writeParams, writeBody)
    if (!result.ok) throw new SaveApiError(result.status, result.error, result.fieldErrors)
    // Update stored version token from write response
    if (entry.contentId && typeof result.data?.version === 'number') {
      entryVersionsRef.current.set(entry.contentId, result.data.version)
    }
    // Warning-level issues from the adopter's validateEntry hook: saved, but surface them
    const validationWarnings = result.data?.validationWarnings
    if (validationWarnings && validationWarnings.length > 0) {
      notifications.show({
        title: 'Saved with warnings',
        // '; '-joined: the notification collapses newlines, so '\n' would run the
        // issues together (matches the '; ' join the save-rejection path uses).
        message: validationWarnings
          .map((issue) =>
            issue.fieldPath ? `${issue.fieldPath}: ${issue.message}` : issue.message,
          )
          .join('; '),
        color: 'yellow',
        autoClose: false,
        withCloseButton: true,
      })
    }
    return normalizeContentPayload(result.data)
  }

  const refreshEntries = async (branch: string = options.branchName): Promise<EditorEntry[]> => {
    if (!branch) return []
    const seq = ++refreshSeqRef.current

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

    // Fetch ALL entries, following the pagination cursor
    const { entries: allEntries, truncated } = await listAllEntries(apiClient, branch)
    if (truncated) {
      console.warn(
        `Entry list truncated at ${MAX_ENTRY_PAGES * ENTRIES_PAGE_LIMIT} entries for branch "${branch}"`,
      )
      notifications.show({
        title: 'Entry list truncated',
        message: `Showing the first ${(MAX_ENTRY_PAGES * ENTRIES_PAGE_LIMIT).toLocaleString()} entries.`,
        color: 'yellow',
      })
    }

    // Build entries with resolved schemas from flatSchema
    const refreshed = buildEntriesFromListResponse({
      response: {
        entries: allEntries,
        pagination: { hasMore: false, limit: ENTRIES_PAGE_LIMIT },
      },
      branchName: branch,
      resolvePreviewSrc: (entry) => options.resolvePreviewSrc(entry) ?? '',
      contentRoot: options.contentRoot || 'content',
      flatSchema: hydratedFlatSchema,
    })

    // Commit collections + entries together, and only if no newer refresh started meanwhile
    if (seq === refreshSeqRef.current) {
      setCollectionsState(collections)
      setEntriesState(refreshed)
    }
    return refreshed
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

      const payload = isDataOnlyFormat(format)
        ? { format: format as 'json' | 'yaml', data: {} }
        : { format, data: {}, body: '' }

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

      const refreshed = await refreshEntries()
      notifications.show({ message: 'Created new entry', color: 'green' })

      // Explicitly navigate to the newly created entry.
      // We find it by matching collectionPath + slug rather than comparing entry
      // counts, which avoids stale-closure race conditions where entriesState is
      // still empty when this function runs (slow server / cold start).
      const createdEntry = refreshed.find(
        (e) => e.collectionPath === createModalCollection.path && e.slug === slug,
      )
      if (createdEntry) {
        setSelectedPath(createdEntry.path)
      } else {
        console.warn(
          `[useEntryManager] Could not navigate to newly created entry: ` +
            `collection=${createModalCollection.path} slug=${slug}`,
        )
      }
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
        // Clear stale OCC version tokens — mtimes differ per branch
        entryVersionsRef.current.clear()
      }

      // Refresh entries for new branch. Guard the cleanup with a per-branch-load
      // token: on a rapid A→B switch where A resolves after B starts, A's `.finally`
      // must not clear the loading flags while B is still in flight (which would
      // reintroduce the very flash entriesInitializing exists to prevent).
      const loadSeq = ++branchLoadSeqRef.current
      options.setBusy(true)
      setEntriesInitializing(true)
      refreshEntries(options.branchName)
        .catch(console.error)
        .finally(() => {
          if (loadSeq !== branchLoadSeqRef.current) return
          options.setBusy(false)
          setEntriesInitializing(false)
        })
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
    entriesInitializing,
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
