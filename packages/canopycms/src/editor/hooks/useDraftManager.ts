import { useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { EditorEntry } from '../Editor'
import type { FormValue } from '../FormRenderer'
import { getNotificationDuration } from '../utils/env'

export interface UseDraftManagerOptions {
  branchName: string
  selectedId: string
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
  editedFiles: Array<{ id: string; label: string }>
  handleSave: () => Promise<void>
  handleDiscardDrafts: () => void
  handleDiscardFileDraft: () => void
  handleReload: () => Promise<void>
  isDirtyForEntry: (entryId: string) => boolean
  isSelectedDirty: () => boolean
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
 *   selectedId,
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

  const selectedValue = drafts[options.selectedId]
  const loadedValue = loadedValues[options.selectedId]
  const effectiveValue = selectedValue ?? loadedValue

  const modifiedCount = useMemo(() => Object.keys(drafts).length, [drafts])

  const editedFiles = useMemo(() => {
    const draftIds = Object.keys(drafts)
    if (draftIds.length === 0) return []
    return draftIds
      .map((id) => {
        const entry = options.entries.find((e) => e.id === id)
        return entry ? { id: entry.id, label: entry.label } : null
      })
      .filter((x): x is { id: string; label: string } => x !== null)
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
    if (!options.currentEntry || !effectiveValue) return
    options.setBusy(true)
    try {
      const saved = await options.saveEntry(options.currentEntry, effectiveValue)
      setDrafts((prev) => ({ ...prev, [options.selectedId]: saved }))
      setLoadedValues((prev) => ({ ...prev, [options.selectedId]: saved }))
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
    if (!options.selectedId) return
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[options.selectedId]
      return next
    })
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem(storageKey)
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, FormValue>
          delete parsed[options.selectedId]
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
    if (!options.currentEntry) return
    options.setBusy(true)
    try {
      const loaded = await options.loadEntry(options.currentEntry)
      setLoadedValues((prev) => ({ ...prev, [options.selectedId]: loaded }))
      setDrafts((prev) => ({ ...prev, [options.selectedId]: loaded }))
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
  const isDirtyForEntry = (entryId: string): boolean => {
    if (!drafts[entryId]) return false
    return (
      !loadedValues[entryId] ||
      JSON.stringify(drafts[entryId]) !== JSON.stringify(loadedValues[entryId])
    )
  }

  // Convenience helper for checking current selection
  const isSelectedDirty = (): boolean => {
    if (!options.selectedId) return false
    return isDirtyForEntry(options.selectedId)
  }

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
  }
}
