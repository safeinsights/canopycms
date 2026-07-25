import { useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import type { EditorEntry } from '../Editor'
import type { ContentId, LogicalPath } from '../../paths/types'
import type { FormValue } from '../FormRenderer'
import { getNotificationDuration } from '../utils/env'
import { validateEntryFormValue, type EntryFieldError } from '../../validation/entry-validator'
import { SaveApiError } from './useEntryManager'

/** Collapse a list of per-field errors into a path → message map (first error per path wins). */
const toFieldErrorMap = (errors: EntryFieldError[]): Record<string, string> => {
  const map: Record<string, string> = {}
  for (const err of errors) {
    if (!(err.fieldPath in map)) map[err.fieldPath] = err.message
  }
  return map
}

/**
 * True when two field-error maps have the same keys and values (order
 * independent). Used to bail out of a state update with the same object
 * reference when a recompute produces an equal-but-newly-allocated map, so
 * consumers that memo on `fieldErrors` identity don't churn.
 */
export const shallowEqualRecord = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export interface UseDraftManagerOptions {
  branchName: string
  selectedPath: string
  currentEntry: EditorEntry | undefined
  entries: EditorEntry[]
  initialValues?: Record<string, FormValue>
  loadEntry: (entry: EditorEntry) => Promise<FormValue>
  saveEntry: (entry: EditorEntry, value: FormValue) => Promise<FormValue>
  setBusy: (busy: boolean) => void
  /**
   * Fired (fire-and-forget) after a successful save. Lets callers refresh
   * data that depends on saved content — e.g. the entries list, so a header/
   * entry-picker label built from a Title field reflects the new value
   * instead of the stale label from the last entries fetch.
   */
  onSaved?: () => void
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
  /**
   * Per-field validation errors for the selected entry, keyed by canonical
   * canopy path (e.g. `blocks[0].title`). Populated when a save is blocked by
   * client-side schema validation (ED-H1) or rejected by the server (422);
   * cleared when the entry changes, and recomputed as the user edits so
   * errors disappear as fields are fixed.
   */
  fieldErrors: Record<string, string>
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
  // Per-field validation errors from a blocked/rejected save (ED-H1), keyed by
  // the entry they belong to. Keying by entry id — and deriving the exposed
  // `fieldErrors` map below instead of clearing it in a separate effect after
  // the entry switches — makes a stale-error flash against the newly-selected
  // entry structurally impossible: there is no render where `errorState`
  // exists but belongs to the wrong entry.
  const [errorState, setErrorState] = useState<{
    entryId: ContentId
    errors: Record<string, string>
  } | null>(null)

  const storageKey = useMemo(() => `canopycms:drafts:${options.branchName}`, [options.branchName])

  // Draft keys are now content IDs, not paths
  const currentId = options.currentEntry?.contentId
  const selectedValue = currentId ? drafts[currentId] : undefined
  const loadedValue = currentId ? loadedValues[currentId] : undefined
  const effectiveValue = selectedValue ?? loadedValue
  const fieldErrors = useMemo(
    () => (errorState && errorState.entryId === currentId ? errorState.errors : {}),
    [errorState, currentId],
  )

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

  // Merge in drafts written by another tab for the same branch. Only fills
  // in keys missing locally, so it never clobbers this tab's in-memory edits.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey || !event.newValue) return
      try {
        const parsed = JSON.parse(event.newValue) as Record<string, FormValue>
        setDrafts((prev) => {
          const missing = Object.keys(parsed).filter((id) => !(id in prev))
          if (missing.length === 0) return prev
          const merged = { ...prev }
          for (const id of missing) merged[id] = parsed[id]
          return merged
        })
      } catch (err) {
        console.warn('Failed to merge drafts from another tab', err)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [storageKey])

  // Tracks which storage key the current in-memory `drafts` were loaded for.
  // Lags one render behind a branch switch (it only updates once `drafts`
  // itself has been reset/restored for the new key), which is what lets the
  // persist effect below detect and skip the stale write.
  const draftsStorageKeyRef = useRef(storageKey)
  useEffect(() => {
    draftsStorageKeyRef.current = storageKey
  }, [drafts])

  // Persist drafts to localStorage whenever they change
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (draftsStorageKeyRef.current !== storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(drafts))
    } catch (err) {
      console.warn('Failed to persist drafts', err)
    }
  }, [drafts, storageKey])

  // While field errors are showing, recompute them as the user edits — or as
  // the selected entry's schema/format changes while it stays open — so each
  // error clears when its field is fixed or no longer required. Errors for a
  // different entry are simply not visible (see the `fieldErrors` derivation
  // above), so this effect only needs to keep `errorState` itself correct.
  //
  // Three things here are load-bearing against render loops/churn — see
  // PR #106 review follow-up item 9:
  //
  // 1. `options.currentEntry?.schema`/`.format` are in the deps (not just
  //    `effectiveValue`/`currentId`) so a schema change while the same entry
  //    stays open re-validates instead of leaving stale errors.
  // 2. The updater is FUNCTIONAL (reads/writes via the `prev` argument), so
  //    `errorState` itself stays out of the dep array. Depending on
  //    `errorState` would mean every write below re-triggers this effect.
  // 3. `shallowEqualRecord` bails out by returning `prev` (the same object
  //    reference) when the recomputed map is equal to the last one. This
  //    matters because `options.currentEntry` is a NEW reference whenever
  //    useEntryManager's `entriesState` is replaced (its `currentEntry` is a
  //    `useMemo` over `entriesState.find(...)`), which would otherwise re-run
  //    this effect on every entries refresh and allocate a new-but-equal
  //    errors object each time — churning any consumer that memoizes on
  //    `fieldErrors` identity.
  //
  // Note: server-only errors (e.g. reference existence) cannot be recomputed
  // client-side and clear on edit; the server re-reports them on save.
  useEffect(() => {
    const entry = options.currentEntry
    const value = effectiveValue
    setErrorState((prev) => {
      if (!prev) return prev
      if (prev.entryId !== currentId) return null // housekeeping only; already invisible via the derivation above
      if (!entry || !value) return prev
      const next = toFieldErrorMap(validateEntryFormValue(entry.schema, entry.format, value))
      return shallowEqualRecord(prev.errors, next) ? prev : { entryId: prev.entryId, errors: next }
    })
  }, [effectiveValue, currentId, options.currentEntry?.schema, options.currentEntry?.format])

  const handleSave = async () => {
    if (!options.currentEntry || !effectiveValue || !currentId) return

    // Client-side pre-save validation (ED-H1): the same pure schema rules the
    // server enforces authoritatively at the write boundary. Blocks the save
    // and surfaces per-field errors in the form instead of a green "Saved".
    const validationErrors = validateEntryFormValue(
      options.currentEntry.schema,
      options.currentEntry.format,
      effectiveValue,
    )
    if (validationErrors.length > 0) {
      setErrorState({ entryId: currentId, errors: toFieldErrorMap(validationErrors) })
      notifications.show({
        title: 'Cannot save yet',
        message: `Fix ${validationErrors.length} validation ${validationErrors.length === 1 ? 'issue' : 'issues'} before saving`,
        color: 'red',
        autoClose: getNotificationDuration(6000),
        withCloseButton: true,
      })
      return
    }
    setErrorState(null)

    options.setBusy(true)
    try {
      const saved = await options.saveEntry(options.currentEntry, effectiveValue)
      // Drop the draft now that it has been persisted, rather than
      // overwriting it with `saved`. `effectiveValue` is `drafts[currentId]
      // ?? loadedValues[currentId]`, and `loadedValues[currentId]` is about
      // to become `saved` below, so removing the draft key is a no-op for
      // the rendered value while fixing the "phantom dirty" bug: a draft
      // that lingers forever is what made every fresh page load show Save
      // enabled with zero real edits (see modifiedCount's doc comment above
      // — a draft without a matching loadedValues entry is conservatively
      // treated as dirty).
      setDrafts((prev) => {
        if (!(currentId in prev)) return prev
        const next = { ...prev }
        delete next[currentId]
        return next
      })
      setLoadedValues((prev) => ({ ...prev, [currentId]: saved }))
      notifications.show({
        message: 'Saved',
        color: 'green',
        autoClose: getNotificationDuration(4000),
        withCloseButton: true,
      })
      options.onSaved?.()
    } catch (err) {
      console.error(err)
      const isConflict = err instanceof SaveApiError && err.status === 409
      // 422 = rejected by server-side schema validation or the adopter's
      // validateEntry hook; show its message and map per-field errors (e.g.
      // reference existence, which only the server can check) into the form.
      const isValidation = err instanceof SaveApiError && err.status === 422
      if (
        err instanceof SaveApiError &&
        err.status === 422 &&
        err.fieldErrors &&
        err.fieldErrors.length > 0
      ) {
        setErrorState({ entryId: currentId, errors: toFieldErrorMap(err.fieldErrors) })
      }
      notifications.show({
        ...(isValidation ? { title: 'Save rejected' } : {}),
        message: isConflict
          ? 'Content was modified by another editor. Reload to see the latest changes.'
          : isValidation
            ? err.message
            : 'Save failed',
        color: isConflict ? 'yellow' : 'red',
        autoClose: getNotificationDuration(isConflict || isValidation ? 8000 : 6000),
        withCloseButton: true,
      })
    } finally {
      options.setBusy(false)
    }
  }

  const performDiscardDrafts = () => {
    setDrafts({})
    setErrorState(null)
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

  // Discarding drafts is destructive, so confirm first — but only when there
  // is actually something to lose (modifiedCount > 0, same definition used
  // everywhere else in this hook). An all-clean discard (e.g. drafts that
  // exactly mirror loaded values) clears silently.
  const handleDiscardDrafts = () => {
    if (modifiedCount === 0) {
      performDiscardDrafts()
      return
    }
    modals.openConfirmModal({
      title: 'Discard drafts',
      children: `Discard drafts for ${modifiedCount} file(s)? Unsaved changes will be lost.`,
      labels: { confirm: 'Discard', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: performDiscardDrafts,
    })
  }

  const performDiscardFileDraft = () => {
    if (!currentId) return
    setErrorState(null)
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

  // Only prompt when there is a real draft that actually differs from the
  // loaded value (`isSelectedDirty()` below uses the exact same
  // JSON.stringify comparison as `modifiedCount`). Discarding a draft that's
  // identical to the loaded value, or discarding when there's no draft at
  // all, has nothing to lose, so it clears silently.
  const handleDiscardFileDraft = () => {
    if (!currentId) return
    if (!isSelectedDirty()) {
      performDiscardFileDraft()
      return
    }
    modals.openConfirmModal({
      title: 'Discard draft',
      children: 'Discard unsaved changes for this file?',
      labels: { confirm: 'Discard', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: performDiscardFileDraft,
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
    fieldErrors,
  }
}
