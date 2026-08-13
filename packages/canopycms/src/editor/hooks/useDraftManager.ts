import { useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import equal from 'fast-deep-equal'
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

/** Storage-format tag for the persisted draft envelope (see `parsePersistedDrafts`). */
const DRAFTS_STORAGE_VERSION = 2

/**
 * What `canopycms:drafts:<branch>` holds today.
 *
 * The pre-v2 shape was a bare `Record<contentId, FormValue>` with no record of
 * which server version each draft was based on -- which is precisely what made
 * cross-session conflicts undetectable: the draft restored, the entry then
 * loaded and captured a FRESH OCC token, and a save sent that fresh token, so
 * a stale snapshot passed the server's conflict check and reverted whatever
 * had landed in between.
 */
interface PersistedDrafts {
  v: typeof DRAFTS_STORAGE_VERSION
  drafts: Record<string, FormValue>
  /**
   * contentId -> the server version the stored draft was based on. `null`
   * means "unknown" and is treated as a conflict on save (see
   * `isDraftBaseStale`).
   */
  baseVersions: Record<string, number | null>
}

/**
 * Read the persisted draft store, tolerating the legacy pre-v2 shape.
 *
 * LEGACY DECISION: a pre-v2 payload carries no base versions at all, and we
 * cannot reconstruct them -- the draft may predate any number of other
 * people's saves. Every legacy draft is therefore restored with base version
 * `null` ("unknown"), which surfaces the conflict UI on save instead of
 * trusting it. Trusting it is the bug being fixed; silently DISCARDING it is a
 * quieter version of the same bug, so the draft is kept and the user is told.
 * This only affects drafts written before this change; everything written
 * after carries a real base version.
 */
const parsePersistedDrafts = (
  raw: string,
): { drafts: Record<string, FormValue>; baseVersions: Record<string, number | null> } => {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') return { drafts: {}, baseVersions: {} }
  if ((parsed as { v?: unknown }).v === DRAFTS_STORAGE_VERSION) {
    const envelope = parsed as Partial<PersistedDrafts>
    return { drafts: envelope.drafts ?? {}, baseVersions: envelope.baseVersions ?? {} }
  }
  const drafts = parsed as Record<string, FormValue>
  const baseVersions: Record<string, number | null> = {}
  for (const id of Object.keys(drafts)) baseVersions[id] = null
  return { drafts, baseVersions }
}

export interface UseDraftManagerOptions {
  branchName: string
  selectedPath: string
  currentEntry: EditorEntry | undefined
  entries: EditorEntry[]
  initialValues?: Record<string, FormValue>
  loadEntry: (entry: EditorEntry) => Promise<FormValue>
  saveEntry: (entry: EditorEntry, value: FormValue) => Promise<FormValue>
  /**
   * The OCC version token currently held for an entry on the branch being
   * shown (useEntryManager's `getEntryVersion`). Used to stamp each draft with
   * the version it was based on, and to detect at save time that the token has
   * since moved on. Optional: without it no base versions are recorded and
   * conflict detection falls back entirely to the server's 409.
   */
  getEntryVersion?: (contentId: string) => number | undefined
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

  // contentId -> the server version the CURRENT draft for that entry is based
  // on. A ref rather than state: nothing renders from it, and the persist
  // effect below must be able to read the value stamped moments earlier in the
  // same commit. Three distinguishable states, all load-bearing:
  //   number  - known base version
  //   null    - draft restored from storage with no recorded base ("unknown")
  //   absent  - draft created this session before any version was known
  //             (adopter-supplied `initialValues`, or an edit that somehow
  //             preceded the entry's first load); treated as safe, matching
  //             the behavior before base versions existed.
  const draftBaseVersionsRef = useRef<Record<string, number | null>>({})
  // The draft ids the reconcile effect below has already accounted for. It
  // prunes on an observed present -> absent TRANSITION rather than on "not
  // currently in drafts": the restore effect stamps base versions for ids
  // whose `setDrafts` has only been QUEUED, so a prune keyed on the current
  // `drafts` would delete every restored base version in the same commit that
  // recorded it -- and the next pass would then re-stamp those drafts with the
  // freshly loaded version, which is exactly the false "no conflict" this
  // mechanism exists to prevent.
  const reconciledDraftIdsRef = useRef<Set<string>>(new Set())

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
  // 2. The comparison uses `fast-deep-equal`, a value-based deep equality
  //    check -- not property-order sensitive the way `JSON.stringify`
  //    comparison was. A rehydrated draft whose keys were serialized in a
  //    different order than the server-loaded object no longer shows as
  //    dirty when the values are semantically identical.
  const modifiedCount = useMemo(
    () =>
      Object.keys(drafts).filter((id) => !loadedValues[id] || !equal(drafts[id], loadedValues[id]))
        .length,
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
      // Base versions are file mtimes, i.e. inherently per-branch -- carrying
      // them across a switch would compare one branch's version against
      // another's.
      draftBaseVersionsRef.current = {}
      reconciledDraftIdsRef.current = new Set()
    }
    prevBranchRef.current = options.branchName
  }, [options.branchName])

  // Restore drafts from localStorage on mount or when storageKey changes
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const { drafts: restored, baseVersions } = parsePersistedDrafts(raw)
        // Stamp the base versions BEFORE queueing the state update: the
        // reconcile effect below only stamps ids it has never seen, so
        // recording them here is what stops a restored draft from being
        // (wrongly) stamped with the version of the load that happens next.
        for (const id of Object.keys(restored)) {
          draftBaseVersionsRef.current[id] = baseVersions[id] ?? null
        }
        setDrafts((prev) => ({ ...prev, ...restored }))
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
        const { drafts: parsed, baseVersions } = parsePersistedDrafts(event.newValue)
        // Same "only fill what's missing" rule as the merge below: an id we
        // already have a base version for is one this tab is already drafting,
        // so the other tab's base version must not overwrite ours.
        for (const id of Object.keys(parsed)) {
          if (!(id in draftBaseVersionsRef.current)) {
            draftBaseVersionsRef.current[id] = baseVersions[id] ?? null
          }
        }
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

  // Keep the per-draft base versions in step with `drafts`.
  //
  // A draft key appearing here for the first time was created by the user
  // editing an entry they had already opened, so the version currently held
  // for that entry IS the version their edit is based on. Keys that disappear
  // (saved, discarded, reloaded) drop their base version with them, so the
  // next edit re-stamps against whatever the server returned most recently.
  //
  // Declared BEFORE the persist effect so both run in the same commit, in this
  // order -- the persist effect reads the ref this one just updated.
  useEffect(() => {
    const bases = draftBaseVersionsRef.current
    const draftIds = new Set(Object.keys(drafts))
    for (const id of draftIds) {
      if (id in bases) continue
      const version = options.getEntryVersion?.(id)
      // Only record a base we actually know. Leaving it absent (rather than
      // writing `null`) keeps "never loaded, so nothing to compare" distinct
      // from "restored with no recorded base", and lets a later edit stamp a
      // real version once one is known.
      if (version !== undefined) bases[id] = version
    }
    for (const id of reconciledDraftIdsRef.current) {
      if (!draftIds.has(id)) delete bases[id]
    }
    reconciledDraftIdsRef.current = draftIds
    // Deliberately keyed on `drafts` alone: `options.getEntryVersion` is a
    // fresh closure every render, and only a drafts change can add or remove
    // the keys this effect reconciles.
  }, [drafts])

  // Persist drafts to localStorage whenever they change
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (draftsStorageKeyRef.current !== storageKey) return
    try {
      const payload: PersistedDrafts = {
        v: DRAFTS_STORAGE_VERSION,
        drafts,
        baseVersions: draftBaseVersionsRef.current,
      }
      window.localStorage.setItem(storageKey, JSON.stringify(payload))
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

  /**
   * The 409 presentation, in one place. The client-side stale-base check below
   * and the server's own 409 response are the same situation from the user's
   * point of view -- someone else's work is at risk -- so they must read
   * identically, and "Reload" (now itself confirmed, see `handleReload`) is the
   * recovery for both.
   */
  const showConflictNotification = () => {
    notifications.show({
      message: 'Content was modified by another editor. Reload to see the latest changes.',
      color: 'yellow',
      autoClose: getNotificationDuration(8000),
      withCloseButton: true,
    })
  }

  /**
   * True when the selected entry's draft is based on a server version that is
   * no longer the one we hold for it.
   *
   * This is the cross-session case the OCC token alone cannot catch: the draft
   * was written against version N, the page was reloaded, the entry was
   * re-read and captured version N+1, and a save would send N+1 -- passing the
   * server's conflict check and reverting whoever wrote N+1. Comparing the
   * draft's own base against the current token catches it BEFORE the write.
   *
   * `null` (unknown -- a draft restored from the pre-v2 storage format) counts
   * as stale for the same reason: we cannot prove it isn't.
   */
  const isDraftBaseStale = (): boolean => {
    if (!currentId || drafts[currentId] === undefined) return false
    const currentVersion = options.getEntryVersion?.(currentId)
    // No server version known for this entry at all -- nothing to compare
    // against, so this check has no opinion (the server's 409 still applies).
    if (currentVersion === undefined) return false
    const base = draftBaseVersionsRef.current[currentId]
    if (base === undefined) return false
    return base === null || base !== currentVersion
  }

  const handleSave = async () => {
    if (!options.currentEntry || !effectiveValue || !currentId) return

    // Conflict check first: a stale-based draft must not be schema-validated
    // into a green "Saved" -- and nagging about field errors is noise when the
    // save is not going out at all.
    if (isDraftBaseStale()) {
      showConflictNotification()
      return
    }

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
      // 403 = the writableBranch guard refused the write outright (base
      // branch read-only, status past 'editing', or unreadable metadata --
      // see api/guards.ts). This is exactly the window a fail-closed but
      // still momentarily-stale client can hit: the branch list hasn't
      // caught up yet, or the editor rendered before the server's answer
      // arrived, so a Save that looked enabled got rejected server-side.
      // #189 wrote specific guard copy explaining WHICH lock applies and how
      // to recover (e.g. "withdraw it to make changes") -- falling through to
      // the generic 'Save failed' below would throw that away in precisely
      // the moment the user is most confused, so surface the server's own
      // message instead, the same way the 422 branch already does.
      const isForbidden = err instanceof SaveApiError && err.status === 403
      if (
        err instanceof SaveApiError &&
        err.status === 422 &&
        err.fieldErrors &&
        err.fieldErrors.length > 0
      ) {
        setErrorState({ entryId: currentId, errors: toFieldErrorMap(err.fieldErrors) })
      }
      if (isConflict) {
        showConflictNotification()
      } else {
        notifications.show({
          ...(isValidation ? { title: 'Save rejected' } : {}),
          ...(isForbidden ? { title: 'Save not allowed' } : {}),
          message: isValidation || isForbidden ? err.message : 'Save failed',
          color: 'red',
          autoClose: getNotificationDuration(isValidation || isForbidden ? 8000 : 6000),
          withCloseButton: true,
        })
      }
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
      children: `Discard drafts for ${modifiedCount} ${modifiedCount === 1 ? 'file' : 'files'}? Unsaved changes will be lost.`,
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
          const { drafts: persisted, baseVersions } = parsePersistedDrafts(raw)
          delete persisted[currentId]
          delete baseVersions[currentId]
          const payload: PersistedDrafts = {
            v: DRAFTS_STORAGE_VERSION,
            drafts: persisted,
            baseVersions,
          }
          window.localStorage.setItem(storageKey, JSON.stringify(payload))
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
  // loaded value (`isSelectedDirty()` below uses the exact same deep-equal
  // comparison as `modifiedCount`). Discarding a draft that's identical to
  // the loaded value, or discarding when there's no draft at all, has
  // nothing to lose, so it clears silently.
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

  const performReload = async () => {
    if (!options.currentEntry || !currentId) return
    options.setBusy(true)
    try {
      const loaded = await options.loadEntry(options.currentEntry)
      setLoadedValues((prev) => ({ ...prev, [currentId]: loaded }))
      // Drop the draft rather than seeding it with `loaded`. `effectiveValue`
      // falls back to `loadedValues`, so the rendered value is identical --
      // and a draft that merely mirrors the server value is exactly the
      // phantom-dirty snapshot this hook works to avoid (same reasoning as
      // handleSave's drop above).
      setDrafts((prev) => {
        if (!(currentId in prev)) return prev
        const next = { ...prev }
        delete next[currentId]
        return next
      })
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

  // Reloading replaces the working value with the server's copy, so over a
  // real draft it is every bit as destructive as "Discard draft" -- and it is
  // what the conflict notification tells the losing editor to do, i.e. the one
  // moment their unsaved work matters most. Guarded exactly like
  // handleDiscardFileDraft: the same `isSelectedDirty()` test (nothing to lose
  // -> no prompt) and the same confirm-modal shape.
  const handleReload = async () => {
    if (!options.currentEntry || !currentId) return
    if (!isSelectedDirty()) {
      await performReload()
      return
    }
    modals.openConfirmModal({
      title: 'Reload file',
      children: 'Reload this file from the server? Unsaved changes for this file will be lost.',
      labels: { confirm: 'Reload', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void performReload()
      },
    })
  }

  // Compute dirty state for a given entry
  const isDirtyForEntry = (entryPath: string): boolean => {
    // Find entry by path to get its content ID
    const entry = options.entries.find((e) => e.path === entryPath)
    if (!entry) return false

    const id = entry.contentId
    if (!drafts[id]) return false
    return !loadedValues[id] || !equal(drafts[id], loadedValues[id])
  }

  // Convenience helper for checking current selection
  const isSelectedDirty = (): boolean => {
    if (!currentId) return false
    if (!drafts[currentId]) return false
    return !loadedValues[currentId] || !equal(drafts[currentId], loadedValues[currentId])
  }

  // Returns true if ANY draft entry differs from its loaded value.
  //
  // Used for branch-switch guards so unsaved work in non-selected entries is not
  // silently discarded. Derived from `modifiedCount`, so its semantics note
  // above also applies: localStorage-restored drafts without a loaded value
  // count as dirty.
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
