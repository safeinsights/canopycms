import { useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { EditorEntry } from '../Editor'
import type { LogicalPath } from '../../paths/types'
import type { FormValue } from '../FormRenderer'
import { getNotificationDuration } from '../utils/env'

export interface UseDraftManagerOptions {
  branchName: string
  selectedPath: string
  currentEntry: EditorEntry | undefined
  entries: EditorEntry[]
  initialValues?: Record<string, FormValue>
  loadEntry: (entry: EditorEntry) => Promise<FormValue>
  saveEntry: (entry: EditorEntry, value: FormValue) => Promise<FormValue>
  setBusy: (busy: boolean) => void
}

export interface UseDraftManagerReturn {
  drafts: Record<string, FormValue>
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, FormValue>>>
  loadedValues: Record<string, FormValue>
  setLoadedValues: React.Dispatch<React.SetStateAction<Record<string, FormValue>>>
  selectedValue: FormValue | undefined
  loadedValue: FormValue | undefined
  effectiveValue: FormValue | undefined
  modifiedCount: number
  editedFiles: Array<{ path: LogicalPath; label: string }>
  handleSave: () => Promise<void>
  handleDiscardDrafts: () => void
  handleDiscardFileDraft: () => void
  handleReload: () => Promise<void>
  isDirtyForEntry: (entryPath: string) => boolean
  isSelectedDirty: () => boolean
  isAnyDirty: () => boolean
}

/**
 * Custom hook for managing draft state (localStorage persistence, save/discard).
 *
 * Handles:
 * - Draft state management
 * - localStorage persistence (restore on mount, persist on change)
 * - Save/discard operations
 * - Reload from server
 * - Computed values (selectedValue, effectiveValue, modifiedCount, editedFiles)
 *
 * @example
 * ```tsx
 * const {
 *   drafts,
 *   effectiveValue,
 *   modifiedCount,
 *   handleSave,
 *   handleDiscardDrafts
 * } = useDraftManager({
 *   branchName,
 *   selectedPath,
 *   currentEntry,
 *   entries,
 *   loadEntry,
 *   saveEntry,
 *   setBusy
 * })
 * ```
 */
export function useDraftManager(options: UseDraftManagerOptions): UseDraftManagerReturn {
  const [drafts, setDrafts] = useState<Record<string, FormValue>>(() => options.initialValues ?? {})
  const [loadedValues, setLoadedValues] = useState<Record<string, FormValue>>({})

  const storageKey = useMemo(() => `canopycms:drafts:${options.branchName}`, [options.branchName])

  // Draft keys are now content IDs, not paths
  const currentId = options.currentEntry?.contentId
  const selectedValue = currentId ? drafts[currentId] : undefined
  const loadedValue = currentId ? loadedValues[currentId] : undefined
  const effectiveValue = selectedValue ?? loadedValue

  // Number of draft entries that differ from their loaded server value.
  //
  // Two intentional behaviors worth noting:
  //
  // 1. A draft without a corresponding `loadedValues` entry (e.g. a localStorage-restored
  //    draft whose entry has not been opened in this session) is counted as dirty. We
  //    cannot prove such a draft matches server state, so we conservatively treat it
  //    as unsaved work — this is what keeps the branch-switch guard from silently
  //    discarding restored drafts.
  //
  // 2. The comparison uses `JSON.stringify`, which is property-order sensitive. A
  //    rehydrated draft whose keys were serialized in a different order than the
  //    server-loaded object will show as dirty even when the values are semantically
  //    identical. This is a known limitation; replacing with `fast-deep-equal` is
  //    tracked in `.claude/future-tasks/editor-async-patterns.md`.
  const modifiedCount = useMemo(
    () =>
      Object.keys(drafts).filter(
        (id) =>
          !loadedValues[id] || JSON.stringify(drafts[id]) !== JSON.stringify(loadedValues[id]),
      ).length,
    [drafts, loadedValues],
  )

  const editedFiles = useMemo(() => {
    const draftIds = Object.keys(drafts)
    if (draftIds.length === 0) return []
    return draftIds
      .map((id) => {
        const entry = options.entries.find((e) => e.contentId === id)
        return entry ? { path: entry.path, label: entry.label } : null
      })
      .filter((x): x is { path: LogicalPath; label: string } => x !== null)
  }, [drafts, options.entries])

  // Clear drafts when branch changes (before localStorage restore)
  const prevBranchRef = useRef(options.branchName)
  useEffect(() => {
    if (prevBranchRef.current && prevBranchRef.current !== options.branchName) {
      setDrafts({})
      setLoadedValues({})
    }
    prevBranchRef.current = options.branchName
  }, [options.branchName])

  // Restore drafts from localStorage on mount or when storageKey changes
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, FormValue>
        setDrafts((prev) => ({ ...prev, ...parsed }))
      }
    } catch (err) {
      console.warn('Failed to restore drafts', err)
    }
  }, [storageKey])

  // Persist drafts to localStorage whenever they change
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(drafts))
    } catch (err) {
      console.warn('Failed to persist drafts', err)
    }
  }, [drafts, storageKey])

  const handleSave = async () => {
    if (!options.currentEntry || !effectiveValue || !currentId) return
    options.setBusy(true)
    try {
      const saved = await options.saveEntry(options.currentEntry, effectiveValue)
      setDrafts((prev) => ({ ...prev, [currentId]: saved }))
      setLoadedValues((prev) => ({ ...prev, [currentId]: saved }))
      notifications.show({
        message: 'Saved',
        color: 'green',
        autoClose: getNotificationDuration(4000),
        withCloseButton: true,
      })
    } catch (err) {
      console.error(err)
      notifications.show({
        message: 'Save failed',
        color: 'red',
        autoClose: getNotificationDuration(6000),
        withCloseButton: true,
      })
    } finally {
      options.setBusy(false)
    }
  }

  const handleDiscardDrafts = () => {
    setDrafts({})
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(storageKey)
      }
    } catch (err) {
      console.warn('Failed to clear drafts', err)
    }
    notifications.show({
      message: 'Drafts cleared',
      color: 'blue',
      autoClose: getNotificationDuration(3000),
      withCloseButton: true,
    })
  }

  const handleDiscardFileDraft = () => {
    if (!currentId) return
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[currentId]
      return next
    })
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem(storageKey)
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, FormValue>
          delete parsed[currentId]
          window.localStorage.setItem(storageKey, JSON.stringify(parsed))
        }
      }
    } catch (err) {
      console.warn('Failed to clear draft for file', err)
    }
    notifications.show({
      message: 'Draft cleared for file',
      color: 'blue',
      autoClose: getNotificationDuration(3000),
      withCloseButton: true,
    })
  }

  const handleReload = async () => {
    if (!options.currentEntry || !currentId) return
    options.setBusy(true)
    try {
      const loaded = await options.loadEntry(options.currentEntry)
      setLoadedValues((prev) => ({ ...prev, [currentId]: loaded }))
      setDrafts((prev) => ({ ...prev, [currentId]: loaded }))
      notifications.show({
        message: 'Reloaded',
        color: 'blue',
        autoClose: getNotificationDuration(3000),
        withCloseButton: true,
      })
    } catch (err) {
      console.error(err)
      notifications.show({
        message: 'Reload failed',
        color: 'red',
        autoClose: getNotificationDuration(6000),
        withCloseButton: true,
      })
    } finally {
      options.setBusy(false)
    }
  }

  // Compute dirty state for a given entry
  const isDirtyForEntry = (entryPath: string): boolean => {
    // Find entry by path to get its content ID
    const entry = options.entries.find((e) => e.path === entryPath)
    if (!entry) return false

    const id = entry.contentId
    if (!drafts[id]) return false
    return !loadedValues[id] || JSON.stringify(drafts[id]) !== JSON.stringify(loadedValues[id])
  }

  // Convenience helper for checking current selection
  const isSelectedDirty = (): boolean => {
    if (!currentId) return false
    if (!drafts[currentId]) return false
    return (
      !loadedValues[currentId] ||
      JSON.stringify(drafts[currentId]) !== JSON.stringify(loadedValues[currentId])
    )
  }

  // Returns true if ANY draft entry differs from its loaded value.
  //
  // Used for branch-switch guards so unsaved work in non-selected entries is not
  // silently discarded. Derived from `modifiedCount`, so the two semantics notes
  // above also apply: localStorage-restored drafts without a loaded value count as
  // dirty, and the underlying comparison is `JSON.stringify`-based.
  const isAnyDirty = (): boolean => modifiedCount > 0

  return {
    drafts,
    setDrafts,
    loadedValues,
    setLoadedValues,
    selectedValue,
    loadedValue,
    effectiveValue,
    modifiedCount,
    editedFiles,
    handleSave,
    handleDiscardDrafts,
    handleDiscardFileDraft,
    handleReload,
    isDirtyForEntry,
    isSelectedDirty,
    isAnyDirty,
  }
}
