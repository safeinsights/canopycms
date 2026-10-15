import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { openConfirm } from '../utils/confirm-modal'
import { focusReturnProps } from '../utils/focus-return'
import equal from 'fast-deep-equal'
import type { EditorEntry } from '../Editor'
import type { ContentId, LogicalPath } from '../../paths/types'
import type { FormValue } from '../FormRenderer'
import type { StampedEntry } from '../../stamp-on-publish'
import { getNotificationDuration } from '../utils/env'
import { validateEntryFormValue, type EntryFieldError } from '../../validation/entry-validator'
import { EntrySchemaUnavailableError, SaveApiError } from './useEntryManager'
import { SCHEMA_UNAVAILABLE_CODE } from '../unavailable-entry-type'
import { ENTRY_CHANGED_MESSAGE } from '../../api/entries-constants'
import type { ApiErrorCode } from '../../api/types'
import { isUnanswered } from '../unanswered'
import { withItemKeys } from '../../item-keys'
import { RetryToastMessage } from '../components/RetryToastMessage'
import { clearSaveAllResult, settleSaveAllEntry } from '../components/SaveAllResult'
import {
  classifySaveAllError,
  invalidReason,
  SAVE_ALL_REASONS,
  type SaveAllFailure,
  type SaveAllProgress,
  type SaveAllResult,
} from './save-all'

/** @internal Exported for tests. */
export const SAVE_TIMED_OUT_MESSAGE =
  "Save didn't finish, and may not have gone through. Your changes are still here, so save again."

/** @internal Exported for tests. Shown when a save may already have landed, until a reload. */
export const SAVE_MAY_HAVE_LANDED_MESSAGE =
  'Your last save may already have gone through. Before saving again, choose "Refresh from server" in the entry\'s menu, on its name; your unsaved edits will be lost.'

const saveMayHaveLandedToastId = (contentId: string) => `canopy-save-may-have-landed:${contentId}`

const saveTimedOutToastId = (contentId: string) => `canopy-save-timed-out:${contentId}`

/** @internal Exported for tests. A save refused because the entry was deleted. */
export const ENTRY_DELETED_MESSAGE =
  'This entry was deleted since you opened it, so it was not saved. Your changes are still in the form until the content list next refreshes and closes it: choose "Save as new entry" to keep them.'

/** @internal Exported for tests. A save refused because the entry was renamed; the editor has opened it. */
export const ENTRY_RENAMED_MESSAGE =
  'This entry was renamed since you opened it, so it was not saved. Your changes moved with it and are still in the form: save again to keep them.'

/** @internal Exported for tests. "Save as new entry" refused because an entry, possibly the user's own earlier attempt, now holds the path. */
export const RECREATE_TAKEN_MESSAGE =
  "An entry with this entry's name already exists, perhaps from your own earlier attempt, so it was not saved as a new entry. Your changes are still in the form: copy what you want to keep into that entry."

/** @internal Exported for tests. The save was refused as gone, and the check for a rename failed. */
export const ENTRY_GONE_UNCHECKED_MESSAGE =
  'This entry was deleted or renamed since you opened it, so it was not saved, and the editor could not check which. Your changes are still in the form until the content list next refreshes and closes it: copy what you want to keep.'

/** @internal Exported for tests. "Save as new entry" landed, but the content list does not show it yet. */
export const RECREATED_NOT_LISTED_MESSAGE =
  "Saved as a new entry, but the content list doesn't show it yet. Reload the page in a moment to open it."

/** @internal Exported for tests. "Save as new entry" got no answer. */
export const RECREATE_TIMED_OUT_MESSAGE =
  'Saving as a new entry may have gone through even though the server didn\'t answer. Choose "Save as new entry" to try again: if it went through, you\'ll be told an entry with this name already exists.'

const entryGoneToastId = (contentId: string) => `canopy-entry-gone:${contentId}`

const ENTRY_GONE_CODE = 'ENTRY_GONE' satisfies ApiErrorCode

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
 * independent). Bails a state update out with the same object reference
 * when a recompute produces an equal-but-newly-allocated map, so consumers
 * that memo on `fieldErrors` identity don't churn.
 */
const shallowEqualRecord = (a: Record<string, string>, b: Record<string, string>): boolean => {
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
   * means "unknown" (see `draftBaseState`): not trusted as fresh, but not
   * treated as known-stale either -- saving prompts once for an explicit
   * overwrite rather than blocking the draft forever.
   */
  baseVersions: Record<string, number | null>
}

/**
 * Read the persisted draft store, tolerating the legacy pre-v2 shape.
 *
 * LEGACY DECISION: a pre-v2 payload carries no base versions at all, and we
 * cannot reconstruct them -- the draft may predate any number of other
 * people's saves. Every legacy draft is therefore restored with base version
 * `null` ("unknown"), which surfaces a confirmation on save instead of
 * trusting it. Trusting it is the bug being fixed; silently DISCARDING it is a
 * quieter version of the same bug, so the draft is kept and the user gets the
 * decision. Nothing here re-stamps `null` (the reconcile effect only fills ids
 * NOT already present), so the ONLY thing that clears it is that confirmation
 * -- which is why blocking on it unconditionally, as an earlier version did,
 * made a legacy draft unsaveable by any sequence of actions, forever.
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
  /**
   * Server read that records no OCC token (useEntryManager's `readEntryValue`),
   * for checking restored drafts of unopened entries. Without it they stay
   * unverified and count as dirty.
   */
  readEntryValue?: (entry: EditorEntry) => Promise<FormValue>
  saveEntry: (entry: EditorEntry, value: FormValue) => Promise<FormValue>
  /**
   * The OCC version token currently held for an entry on the branch being
   * shown (useEntryManager's `getEntryVersion`). Stamps each draft with the
   * version it was based on, and detects at save time that the token has
   * since moved on. Optional: without it no base versions are recorded and
   * conflict detection falls back entirely to saveEntry's token check.
   */
  getEntryVersion?: (contentId: string) => number | undefined
  /** Holds a version the server moved an entry to itself (useEntryManager's `adoptEntryVersion`). */
  adoptEntryVersion?: (contentId: string, version: number) => void
  setBusy: (busy: boolean) => void
  /**
   * Fired (fire-and-forget) after a successful save. Lets callers refresh
   * data that depends on saved content — e.g. the entries list, so a header/
   * entry-picker label built from a Title field reflects the new value
   * instead of the stale label from the last entries fetch.
   */
  onSaved?: () => void
  /**
   * Fired when drafts are thrown away for the server's copy: Discard (one entry, or every entry
   * when `contentId` is undefined) and Reload. Anything built on the discarded draft, such as an
   * Undo, no longer applies.
   */
  onDraftsReset?: (contentId?: string) => void
  /** Finds an entry a save reported gone under its new name (useEntryManager's `followMovedEntry`). */
  followMovedEntry?: (entry: EditorEntry) => Promise<EditorEntry | undefined>
  /** Creates a deleted entry again from its draft (useEntryManager's `recreateEntry`). */
  recreateEntry?: (entry: EditorEntry, value: FormValue) => Promise<EditorEntry | undefined>
}

/** The unsaved work a branch-level action would leave behind. `labels` names the entries (it may be shorter than `count`). */
export interface UnsavedSummary {
  count: number
  labels: string[]
}

const VERIFY_CONCURRENCY = 4
/** How long `whenDraftsVerified` waits before answering with whatever is known. */
const VERIFY_WAIT_CAP_MS = 3000

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
  /**
   * Saves every entry with unsaved changes on the branch, one at a time. Undefined when a run is
   * already in flight, or the branch changed before it started.
   */
  handleSaveAll: () => Promise<SaveAllResult | undefined>
  /** Set while Save all runs. */
  saveAllProgress: SaveAllProgress | null
  handleDiscardDrafts: (returnFocusTo?: () => HTMLElement | null) => void
  /** `announce` toasts the discard, for a draft the form isn't showing (a read-only branch's). */
  handleDiscardFileDraft: (
    returnFocusTo?: () => HTMLElement | null,
    options?: { announce?: boolean },
  ) => void
  handleReload: (returnFocusTo?: () => HTMLElement | null) => Promise<void>
  isDirtyForEntry: (entryPath: string) => boolean
  isSelectedDirty: () => boolean
  isAnyDirty: () => boolean
  /** Resolves once restored drafts have been checked against the server (or a read failed), capped so a hung read cannot block. */
  whenDraftsVerified: () => Promise<void>
  /** `whenDraftsVerified`, then the entries still counted dirty. */
  resolveUnsaved: () => Promise<UnsavedSummary>
  /**
   * Per-field validation errors for the selected entry, keyed by canonical
   * canopy path (e.g. `blocks[0].title`). Populated when a save is blocked by
   * client-side schema validation (ED-H1) or rejected by the server (422);
   * cleared when the entry changes, and recomputed as the user edits so
   * errors disappear as fields are fixed.
   */
  fieldErrors: Record<string, string>
  /** True while the last write of drafts to localStorage failed. */
  draftStorageFailed: boolean
  /** Moves loaded values, tokens and drafts onto the versions a submit's stamps left. */
  applySubmitStamps: (stamped: readonly StampedEntry[]) => void
}

/**
 * Custom hook for managing draft state (localStorage persistence, save/discard).
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
  const [draftStorageFailed, setDraftStorageFailed] = useState(false)
  const [saveInFlight, setSaveInFlight] = useState(false)
  const [saveAllProgress, setSaveAllProgress] = useState<SaveAllProgress | null>(null)
  const saveAllRunningRef = useRef(false)
  const singleSaveRef = useRef(false)
  // contentId -> the token held when a save came back WRITE_OUTCOME_UNKNOWN, or when the retry of
  // a timed-out save was refused as a version conflict. That save may have landed, so re-sending
  // the token would bounce off the user's own write; held until re-read.
  const reloadRequiredRef = useRef<Record<string, number | undefined>>({})
  // Entries whose timed-out save toast is up, taken down once a save, reload, discard or branch
  // switch ends it, or a retry is refused as having landed.
  const timedOutSavesRef = useRef(new Set<string>())
  // Entries whose "deleted" toast is up, taken down once a save, reload, discard or branch switch
  // ends it.
  const goneEntriesRef = useRef(new Set<string>())
  // Entries whose "Save as new entry" create is in flight, so a second activation sends none.
  const recreatingRef = useRef(new Set<string>())
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
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const selectedValue = currentId ? drafts[currentId] : undefined
  const loadedValue = currentId ? loadedValues[currentId] : undefined
  const effectiveValue = selectedValue ?? loadedValue
  const fieldErrors = useMemo(
    () => (errorState && errorState.entryId === currentId ? errorState.errors : {}),
    [errorState, currentId],
  )

  // Server values read for restored drafts of unopened entries that differ from
  // the draft. Not `loadedValues`: that map gates the entry load and OCC token.
  const [verifiedBaselines, setVerifiedBaselines] = useState<Record<string, FormValue>>({})
  // Ids whose verification read failed: still dirty, but no longer awaited.
  const [unreadableIds, setUnreadableIds] = useState<ReadonlySet<string>>(() => new Set())
  const requestedIdsRef = useRef<Set<string>>(new Set())
  const verifyQueueRef = useRef<Array<{ entry: EditorEntry; branch: string }>>([])
  const verifyActiveRef = useRef(0)
  const verifyWaitersRef = useRef<Array<() => void>>([])

  const entryById = useMemo(
    () => new Map(options.entries.map((e) => [e.contentId as string, e])),
    [options.entries],
  )
  // Empty while a branch switch loads, so only a non-empty list can say an entry is gone.
  const entriesKnown = options.entries.length > 0

  // The draft ids that count as unsaved work:
  //
  // 1. A draft with no baseline (loaded or verified value) counts as dirty: it
  //    cannot be proven to match the server, and counting it keeps the
  //    branch-switch guard from silently discarding restored drafts.
  //    Verification (below) removes the ones that turn out pristine.
  //
  // 2. A draft for an entry that no longer exists can never be loaded or saved,
  //    so it is not counted. It stays in storage.
  //
  // 3. The comparison is `fast-deep-equal`, so key insertion order of a
  //    rehydrated draft does not make it dirty.
  const dirtyIds = useMemo(
    () =>
      Object.keys(drafts).filter((id) => {
        if (entriesKnown && !entryById.has(id)) return false
        const baseline = loadedValues[id] ?? verifiedBaselines[id]
        return baseline === undefined || !equal(drafts[id], baseline)
      }),
    [drafts, loadedValues, verifiedBaselines, entriesKnown, entryById],
  )
  const modifiedCount = dirtyIds.length

  const editedFiles = useMemo(
    () =>
      dirtyIds
        .map((id) => {
          const entry = entryById.get(id)
          return entry ? { path: entry.path, label: entry.label } : null
        })
        .filter((x): x is { path: LogicalPath; label: string } => x !== null),
    [dirtyIds, entryById],
  )

  // Draft ids verification can still settle.
  const unresolvedIds = useMemo(
    () =>
      options.readEntryValue && entriesKnown
        ? Object.keys(drafts).filter(
            (id) =>
              entryById.has(id) &&
              loadedValues[id] === undefined &&
              verifiedBaselines[id] === undefined &&
              !unreadableIds.has(id),
          )
        : [],
    [
      drafts,
      loadedValues,
      verifiedBaselines,
      unreadableIds,
      entriesKnown,
      entryById,
      options.readEntryValue,
    ],
  )

  // Async callbacks outlive the render that created them; these give them current values.
  const latestRef = useRef({
    drafts,
    loadedValues,
    unresolvedCount: 0,
    modifiedCount,
    editedFiles,
    dirtyIds,
    entryById,
  })
  latestRef.current = {
    drafts,
    loadedValues,
    unresolvedCount: unresolvedIds.length,
    modifiedCount,
    editedFiles,
    dirtyIds,
    entryById,
  }
  const latestOptionsRef = useRef(options)
  latestOptionsRef.current = options

  // Clear drafts when branch changes (before localStorage restore)
  const prevBranchRef = useRef(options.branchName)
  useEffect(() => {
    if (prevBranchRef.current && prevBranchRef.current !== options.branchName) {
      setDrafts({})
      setLoadedValues({})
      setVerifiedBaselines({})
      setUnreadableIds(new Set())
      requestedIdsRef.current = new Set()
      verifyQueueRef.current = []
      // Base versions are file mtimes, i.e. inherently per-branch -- carrying
      // them across a switch would compare one branch's version against
      // another's.
      draftBaseVersionsRef.current = {}
      for (const id of Object.keys(reloadRequiredRef.current)) {
        notifications.hide(saveMayHaveLandedToastId(id))
      }
      reloadRequiredRef.current = {}
      // A timed-out save belongs to the branch it was sent to; content ids repeat across branches.
      for (const id of timedOutSavesRef.current) notifications.hide(saveTimedOutToastId(id))
      timedOutSavesRef.current.clear()
      for (const id of goneEntriesRef.current) notifications.hide(entryGoneToastId(id))
      goneEntriesRef.current.clear()
      // Its entries, and their "Open" and "Save as new entry" buttons, are the old branch's.
      clearSaveAllResult()
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
      setDraftStorageFailed(false)
    } catch (err) {
      console.warn('Failed to persist drafts', err)
      setDraftStorageFailed(true)
    }
  }, [drafts, storageKey])

  // Drafts survive a reload in localStorage, so leaving is guarded only when it loses work.
  const leaveLosesWork = saveInFlight || (draftStorageFailed && modifiedCount > 0)
  useEffect(() => {
    if (!leaveLosesWork || typeof window === 'undefined') return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [leaveLosesWork])

  // A pre-key draft gains the keys a read gives, so an unchanged one drops, if free of references.
  useEffect(() => {
    const keyed = new Map<string, FormValue>()
    for (const [id, draft] of Object.entries(drafts)) {
      const schema = entryById.get(id)?.schema
      const next = schema ? withItemKeys(schema, draft, 'content') : draft
      if (next !== draft) keyed.set(id, next)
    }
    if (keyed.size === 0) return
    setDrafts((prev) => {
      const next = { ...prev }
      for (const [id, value] of keyed) if (prev[id] === drafts[id]) next[id] = value
      return next
    })
  }, [drafts, entryById])

  // A draft equal to its entry's loaded value is not an edit. Drops it so it
  // neither counts as dirty nor lingers in storage.
  useEffect(() => {
    const redundant = Object.keys(drafts).filter(
      (id) => loadedValues[id] !== undefined && equal(drafts[id], loadedValues[id]),
    )
    if (redundant.length === 0) return
    setDrafts((prev) => {
      const next = { ...prev }
      let changed = false
      for (const id of redundant) {
        if (id in next && equal(next[id], loadedValues[id])) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [drafts, loadedValues])

  // Checks one restored draft against the server. The branch is re-read at
  // settle time: a switch mid-read makes the result another branch's value.
  const verifyDraft = async (job: { entry: EditorEntry; branch: string }) => {
    const id = job.entry.contentId as string
    const read = latestOptionsRef.current.readEntryValue
    if (!read) return
    // The server refuses to read an entry of an unavailable type, so it settles unread at once.
    if (job.entry.unavailable) {
      setUnreadableIds((prev) => new Set(prev).add(id))
      return
    }
    try {
      const server = await read(job.entry)
      if (latestOptionsRef.current.branchName !== job.branch) return
      const { drafts: latestDrafts, loadedValues: latestLoaded } = latestRef.current
      // Gone, or the entry's own load has taken over as the baseline.
      if (latestDrafts[id] === undefined || latestLoaded[id] !== undefined) return
      if (equal(latestDrafts[id], server)) {
        setDrafts((prev) => {
          if (!(id in prev) || !equal(prev[id], server)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      } else {
        setVerifiedBaselines((prev) => ({ ...prev, [id]: server }))
      }
    } catch {
      // Stays unverified, so the draft keeps counting as dirty.
      if (latestOptionsRef.current.branchName !== job.branch) return
      setUnreadableIds((prev) => new Set(prev).add(id))
    }
  }

  const pumpVerification = () => {
    while (verifyActiveRef.current < VERIFY_CONCURRENCY && verifyQueueRef.current.length > 0) {
      const job = verifyQueueRef.current.shift()
      if (!job) break
      verifyActiveRef.current++
      void verifyDraft(job).finally(() => {
        verifyActiveRef.current--
        pumpVerification()
      })
    }
  }

  // Once per branch session, reads the server value of every restored draft
  // whose entry has not loaded. The selected entry is left to its own load,
  // which fills `loadedValues` and lets the effect above drop a pristine draft.
  useEffect(() => {
    if (!options.readEntryValue || !entriesKnown) return
    // `drafts` lags a branch switch by a render (see draftsStorageKeyRef); reading
    // the old branch's drafts under the new branch's name would be wrong.
    if (draftsStorageKeyRef.current !== storageKey) return
    const todo = unresolvedIds.filter((id) => id !== currentId && !requestedIdsRef.current.has(id))
    if (todo.length === 0) return
    for (const id of todo) {
      requestedIdsRef.current.add(id)
      const entry = entryById.get(id)
      if (entry) verifyQueueRef.current.push({ entry, branch: options.branchName })
    }
    pumpVerification()
    // pumpVerification/verifyDraft only touch refs and stable setters.
  }, [unresolvedIds, currentId, storageKey])

  // Wakes `whenDraftsVerified` callers once nothing is left to settle.
  useEffect(() => {
    if (unresolvedIds.length > 0) return
    const waiters = verifyWaitersRef.current
    verifyWaitersRef.current = []
    for (const wake of waiters) wake()
  }, [unresolvedIds])

  // Recomputes field errors as the user edits, or as the selected entry's
  // schema/format changes while it stays open, so each error clears when its
  // field is fixed or no longer required. Errors for a different entry are
  // simply not visible (see the `fieldErrors` derivation above), so this
  // effect only needs to keep `errorState` itself correct. Server-only
  // errors (e.g. reference existence) can't be recomputed client-side and
  // clear on edit; the server re-reports them on save.
  //
  // Three things keep this from causing render loops/churn:
  // 1. `options.currentEntry?.schema`/`.format` are in the deps (not just
  //    `effectiveValue`/`currentId`), so a schema change while the same
  //    entry stays open re-validates instead of leaving stale errors.
  // 2. The updater is FUNCTIONAL (via the `prev` argument), keeping
  //    `errorState` itself out of the dep array -- depending on it would
  //    mean every write below re-triggers this effect.
  // 3. `shallowEqualRecord` returns `prev` unchanged when the recomputed map
  //    is equal, which matters because `options.currentEntry` is a NEW
  //    reference on every entries refresh (`currentEntry` is a `useMemo`
  //    over `entriesState.find(...)`) -- without it, every refresh would
  //    allocate a new-but-equal errors object and churn any consumer
  //    memoizing on `fieldErrors` identity.
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
   * The 409 presentation. Server 409s differ in cause and recovery (version
   * moved on, branch syncing, write may have landed), so their own wording is
   * shown; the default is the version-mismatch wording the stale-base check
   * below shares.
   */
  const showConflictNotification = (message: string = ENTRY_CHANGED_MESSAGE) => {
    notifications.show({
      message,
      color: 'yellow',
      autoClose: getNotificationDuration(8000),
      withCloseButton: true,
    })
  }

  /**
   * Stays until dismissed or the entry is reloaded: saving is held until then. Named, since it
   * outlasts opening other entries.
   */
  const showSaveMayHaveLanded = (entry: EditorEntry, message = SAVE_MAY_HAVE_LANDED_MESSAGE) => {
    notifications.hide(saveMayHaveLandedToastId(entry.contentId))
    notifications.show({
      id: saveMayHaveLandedToastId(entry.contentId),
      title: `No answer saving "${entry.label}"`,
      message: message || SAVE_MAY_HAVE_LANDED_MESSAGE,
      color: 'yellow',
      autoClose: false,
      withCloseButton: true,
    })
  }

  const hideEntryGone = (contentId: string) => {
    if (goneEntriesRef.current.delete(contentId)) notifications.hide(entryGoneToastId(contentId))
  }

  /**
   * Sticky: the form shows the changes only until the list next refreshes and closes it. Offers the
   * deliberate create on the save's branch. Hidden first so a repeat is announced again.
   */
  const showEntryGone = (
    entry: EditorEntry,
    branch: string,
    message = ENTRY_DELETED_MESSAGE,
    offerCreate = true,
  ) => {
    goneEntriesRef.current.add(entry.contentId)
    notifications.hide(entryGoneToastId(entry.contentId))
    notifications.show({
      id: entryGoneToastId(entry.contentId),
      title: `"${entry.label}" not saved`,
      message: offerCreate
        ? createElement(RetryToastMessage, {
            message,
            actionLabel: 'Save as new entry',
            onRetry: () => void recreateGoneEntry(entry, branch),
          })
        : message,
      color: 'yellow',
      autoClose: false,
      withCloseButton: true,
    })
  }

  /** "Save as new entry", once at a time, and only on its branch: after a switch the drafts are another branch's. */
  const recreateGoneEntry = async (entry: EditorEntry, branch: string) => {
    const id = entry.contentId
    const onBranch = () => latestOptionsRef.current.branchName === branch
    const inFlightKey = `${branch}:${id}`
    if (recreatingRef.current.has(inFlightKey)) return
    if (!onBranch()) {
      notifications.hide(entryGoneToastId(id))
      return
    }
    const { drafts: latestDrafts, loadedValues: latestLoaded } = latestRef.current
    const value = latestDrafts[id] ?? latestLoaded[id]
    const recreate = latestOptionsRef.current.recreateEntry
    if (!value || !recreate) return
    recreatingRef.current.add(inFlightKey)
    hideEntryGone(id)
    options.setBusy(true)
    try {
      const created = await recreate(entry, value)
      if (!onBranch()) return
      if (created) {
        // The changes now live in the new entry, under a new content ID; edits made while the
        // create was in flight follow it there.
        setDrafts((prev) => {
          if (!(id in prev)) return prev
          const { [id]: latest, ...rest } = prev
          return equal(latest, value) ? rest : { ...rest, [created.contentId]: latest }
        })
      }
      if (created) settleSaveAllEntry(id)
      notifications.show({
        message: created ? 'Saved as a new entry' : RECREATED_NOT_LISTED_MESSAGE,
        color: 'green',
        autoClose: getNotificationDuration(created ? 4000 : 8000),
        withCloseButton: true,
      })
    } catch (err) {
      console.error(err)
      if (!onBranch()) return
      if (err instanceof SaveApiError && err.status === 409) {
        showEntryGone(entry, branch, RECREATE_TAKEN_MESSAGE)
      } else if (isUnanswered(err)) {
        showEntryGone(entry, branch, RECREATE_TIMED_OUT_MESSAGE)
      } else {
        showEntryGone(
          entry,
          branch,
          err instanceof SaveApiError && err.serverMessage
            ? `It was not saved as a new entry: ${err.serverMessage}`
            : 'It was not saved as a new entry. Your changes are still in the form.',
        )
      }
    } finally {
      recreatingRef.current.delete(inFlightKey)
      options.setBusy(false)
    }
  }

  /**
   * How the selected entry's draft relates to the server version we hold.
   *
   * - `ok`: nothing to object to (or nothing to compare against).
   * - `stale`: the draft was written against version N, the page was
   *   reloaded, the entry was re-read and captured version N+1, and a save
   *   would send N+1 -- passing the server's conflict check and reverting
   *   whoever wrote N+1. This is the cross-session case the OCC token alone
   *   cannot catch, and the draft's own base is what catches it BEFORE the
   *   write.
   * - `unknown-base`: a draft restored from the pre-v2 storage format, which
   *   recorded no base at all. Cannot be PROVEN fresh, but is not known
   *   stale either, and the two must not be treated identically -- see
   *   `handleSave`.
   */
  type DraftBaseState = 'ok' | 'stale' | 'unknown-base'

  const draftBaseState = (): DraftBaseState => {
    if (!currentId || drafts[currentId] === undefined) return 'ok'
    const currentVersion = options.getEntryVersion?.(currentId)
    // No server version known for this entry at all -- nothing to compare
    // against, so this check has no opinion: saveEntry refuses a save without
    // a token, and the server refuses a version-less update.
    if (currentVersion === undefined) return 'ok'
    const base = draftBaseVersionsRef.current[currentId]
    if (base === undefined) return 'ok'
    if (base === null) return 'unknown-base'
    return base !== currentVersion ? 'stale' : 'ok'
  }

  /**
   * One-time upgrade prompt for a draft carried across the pre-v2 -> v2
   * storage change.
   *
   * A bounded, one-time population deserves a decision, not a dead end. On
   * confirm the base is re-stamped to the version currently held, so the
   * draft rejoins the ordinary flow and this is never asked again -- and the
   * server's own OCC check remains the backstop for the case where the
   * answer was wrong.
   */
  const confirmUnknownBaseSave = (): Promise<boolean> =>
    new Promise((resolve) => {
      let decided = false
      const settle = (value: boolean) => {
        if (decided) return
        decided = true
        resolve(value)
      }
      openConfirm({
        title: 'Unsaved draft from an older editor version',
        children:
          'This draft was saved by an earlier version of the editor, which did not record ' +
          'which version of the entry it was based on. Saving it will overwrite the copy ' +
          'currently on the server, including any changes made by someone else since. ' +
          'Choose "Refresh from server" or "Discard changes" in the entry\'s menu, on its name, ' +
          'instead if you would rather not risk that.',
        labels: { confirm: 'Save anyway', cancel: 'Cancel' },
        confirmProps: { color: 'red' },
        onConfirm: () => settle(true),
        // onCancel alone is not enough: Mantine does not fire it when the
        // modal is dismissed via Escape or the overlay, which would leave
        // this promise pending forever. onClose fires for every dismissal.
        onCancel: () => settle(false),
        onClose: () => settle(false),
      })
    })

  const handleSave = async () => {
    // Save all may be sending this entry with the same token; the loser's 409 would be a false conflict.
    if (saveAllRunningRef.current) return
    const entry = options.currentEntry
    const branch = options.branchName
    if (!entry || !effectiveValue || !currentId) return

    if (currentId in reloadRequiredRef.current) {
      if (reloadRequiredRef.current[currentId] === options.getEntryVersion?.(currentId)) {
        showSaveMayHaveLanded(entry)
        return
      }
      delete reloadRequiredRef.current[currentId]
      notifications.hide(saveMayHaveLandedToastId(currentId))
    }

    // Conflict check first: a stale-based draft must not be schema-validated
    // into a green "Saved" -- and nagging about field errors is noise when the
    // save is not going out at all.
    const baseState = draftBaseState()
    if (baseState === 'stale') {
      showConflictNotification()
      return
    }
    if (baseState === 'unknown-base') {
      if (!(await confirmUnknownBaseSave())) return
      // Re-stamp so the draft rejoins the ordinary flow: from here on its base
      // is a real version and the normal stale check applies. Done BEFORE the
      // write so a failed save doesn't re-prompt on every retry.
      const currentVersion = options.getEntryVersion?.(currentId)
      if (currentVersion !== undefined) draftBaseVersionsRef.current[currentId] = currentVersion
    }

    // Client-side pre-save validation (ED-H1): the same pure schema rules the
    // server enforces authoritatively at the write boundary. Blocks the save
    // and surfaces per-field errors in the form instead of a green "Saved".
    const validationErrors = validateEntryFormValue(entry.schema, entry.format, effectiveValue)
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
    setSaveInFlight(true)
    singleSaveRef.current = true
    try {
      const saved = await options.saveEntry(entry, effectiveValue)
      if (latestOptionsRef.current.branchName !== branch) return
      // Drop the draft now that it has been persisted, rather than
      // overwriting it with `saved`. `effectiveValue` is `drafts[currentId]
      // ?? loadedValues[currentId]`, and `loadedValues[currentId]` is about
      // to become `saved` below, so removing the draft key is a no-op for
      // the rendered value while fixing the "phantom dirty" bug: a draft
      // that lingers forever is what made every fresh page load show Save
      // enabled with zero real edits (see `dirtyIds` above: a draft with no
      // baseline is conservatively treated as dirty).
      setDrafts((prev) => {
        if (!(currentId in prev)) return prev
        const next = { ...prev }
        delete next[currentId]
        return next
      })
      setLoadedValues((prev) => ({ ...prev, [currentId]: saved }))
      if (timedOutSavesRef.current.delete(currentId)) {
        notifications.hide(saveTimedOutToastId(currentId))
      }
      hideEntryGone(currentId)
      settleSaveAllEntry(currentId)
      notifications.show({
        message: 'Saved',
        color: 'green',
        autoClose: getNotificationDuration(4000),
        withCloseButton: true,
      })
      options.onSaved?.()
    } catch (err) {
      console.error(err)
      // Content ids repeat across branches: none of what follows belongs on the next one.
      if (latestOptionsRef.current.branchName !== branch) return
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
      // The entry's type has no schema in the running code; the server's message says why.
      const isUnavailable = err instanceof SaveApiError && err.code === SCHEMA_UNAVAILABLE_CODE
      if (
        err instanceof SaveApiError &&
        err.status === 422 &&
        err.fieldErrors &&
        err.fieldErrors.length > 0
      ) {
        setErrorState({ entryId: currentId, errors: toFieldErrorMap(err.fieldErrors) })
      }
      if (isConflict && err.code === ENTRY_GONE_CODE) {
        // Deleted or renamed since it was read, by someone else or by a delete or rename of this
        // user's that got no answer. A retry cannot save it, so the timed-out toast's "save
        // again" no longer applies. A rename keeps the content ID, so the entry is looked for
        // under its new name, where the draft follows it.
        if (timedOutSavesRef.current.delete(currentId)) {
          notifications.hide(saveTimedOutToastId(currentId))
        }
        let moved: EditorEntry | undefined
        let checked = true
        try {
          moved = await options.followMovedEntry?.(entry)
        } catch (followErr) {
          console.error(followErr)
          checked = false
        }
        // A branch switch meanwhile cleared this branch's toasts; none of these belong on the next.
        if (latestOptionsRef.current.branchName !== branch) return
        if (moved) {
          hideEntryGone(currentId)
          notifications.show({
            title: `"${entry.label}" not saved`,
            message: ENTRY_RENAMED_MESSAGE,
            color: 'yellow',
            autoClose: getNotificationDuration(8000),
            withCloseButton: true,
          })
        } else if (checked) {
          showEntryGone(entry, branch)
        } else {
          // Deleted or renamed, but which is unknown, so a create could duplicate a renamed entry.
          showEntryGone(entry, branch, ENTRY_GONE_UNCHECKED_MESSAGE, false)
        }
      } else if (isConflict) {
        // A version conflict on the retry of a save that went unanswered is most likely that
        // save having landed, which a reload settles just as for WRITE_OUTCOME_UNKNOWN.
        const ownSaveLanded =
          err.serverMessage === ENTRY_CHANGED_MESSAGE && timedOutSavesRef.current.has(currentId)
        if (err.code === 'WRITE_OUTCOME_UNKNOWN' || ownSaveLanded) {
          reloadRequiredRef.current[currentId] = options.getEntryVersion?.(currentId)
        }
        if (ownSaveLanded) {
          timedOutSavesRef.current.delete(currentId)
          notifications.hide(saveTimedOutToastId(currentId))
        }
        if (err.code === 'WRITE_OUTCOME_UNKNOWN' || ownSaveLanded) {
          showSaveMayHaveLanded(entry, ownSaveLanded ? undefined : err.serverMessage)
        } else {
          showConflictNotification(err.serverMessage || undefined)
        }
      } else if (isUnanswered(err)) {
        // A save that did land moved the file's version, so the server refuses the retry as a
        // conflict; a file since deleted or moved refuses it as gone (`ContentStore.write`).
        timedOutSavesRef.current.add(currentId)
        notifications.show({
          id: saveTimedOutToastId(currentId),
          title: `No answer saving "${entry.label}"`,
          message: SAVE_TIMED_OUT_MESSAGE,
          color: 'yellow',
          autoClose: false,
          withCloseButton: true,
        })
      } else {
        const explained = isValidation || isForbidden || isUnavailable
        notifications.show({
          ...(isValidation ? { title: 'Save rejected' } : {}),
          ...(isForbidden ? { title: 'Save not allowed' } : {}),
          ...(isUnavailable ? { title: 'Not saved yet' } : {}),
          message: explained ? err.message : 'Save failed',
          color: isUnavailable ? 'yellow' : 'red',
          autoClose: getNotificationDuration(explained ? 8000 : 6000),
          withCloseButton: true,
        })
      }
    } finally {
      singleSaveRef.current = false
      setSaveInFlight(false)
      options.setBusy(false)
    }
  }

  /**
   * A save that got no answer landed if the server now holds exactly what was sent. Only that
   * answer settles it: a differing value may be the server's normalisation of a save that did
   * land, so it leaves the token alone and the retry's 409 decides, as for `handleSave`.
   */
  const settleUnansweredSave = async (entry: EditorEntry, sent: FormValue) => {
    const { readEntryValue, loadEntry } = latestOptionsRef.current
    try {
      if (!readEntryValue || !equal(await readEntryValue(entry), sent)) return undefined
      const loaded = await loadEntry(entry)
      return equal(loaded, sent) ? loaded : undefined
    } catch (err) {
      console.error(err)
      return undefined
    }
  }

  /**
   * One entry of Save all, through the same checks as `handleSave`: held saves, the draft's base
   * version, schema validation, then the OCC-checked write. An entry not opened this session has
   * no token yet, so it is loaded first, which also lets the base check see whether it moved on.
   * Returns undefined when the draft went away meanwhile.
   */
  const saveOneOfAll = async (
    entry: EditorEntry,
    branch: string,
  ): Promise<{ saved: true } | { saved: false; failure: SaveAllFailure } | undefined> => {
    const id = entry.contentId
    const sent = latestRef.current.drafts[id]
    if (sent === undefined) return undefined
    const onBranch = () => latestOptionsRef.current.branchName === branch
    const fail = (
      kind: SaveAllFailure['kind'],
      reason: string,
      extra?: Partial<Pick<SaveAllFailure, 'recreate' | 'path'>>,
    ) => ({
      saved: false as const,
      failure: { contentId: id, label: entry.label, path: entry.path, kind, reason, ...extra },
    })
    const { getEntryVersion, loadEntry, saveEntry } = latestOptionsRef.current

    if (entry.unavailable) return fail('blocked', SAVE_ALL_REASONS.unavailable)
    if (entry.canEdit === false) return fail('blocked', SAVE_ALL_REASONS.noEditAccess)
    if (id in reloadRequiredRef.current) {
      if (reloadRequiredRef.current[id] === getEntryVersion?.(id)) {
        return fail('unanswered', SAVE_ALL_REASONS.earlierUnanswered)
      }
      delete reloadRequiredRef.current[id]
      notifications.hide(saveMayHaveLandedToastId(id))
    }
    if (getEntryVersion?.(id) === undefined) {
      try {
        await loadEntry(entry)
      } catch (err) {
        console.error(err)
        return fail('error', SAVE_ALL_REASONS.loadFailed)
      }
      if (!onBranch()) return undefined
    }
    const base = draftBaseVersionsRef.current[id]
    if (base === null) return fail('conflict', SAVE_ALL_REASONS.unknownBase)
    if (base !== undefined && base !== getEntryVersion?.(id)) {
      return fail('conflict', SAVE_ALL_REASONS.staleBase)
    }
    const validationErrors = validateEntryFormValue(entry.schema, entry.format, sent)
    if (validationErrors.length > 0) {
      if (id === currentIdRef.current) {
        setErrorState({ entryId: id, errors: toFieldErrorMap(validationErrors) })
      }
      return fail('invalid', invalidReason(validationErrors.length))
    }

    const commitSaved = (saved: FormValue) => {
      // Edits typed while the save was out stay a draft, now based on the version just written.
      const latest = latestRef.current.drafts[id]
      if (latest !== undefined && !equal(latest, sent)) {
        const version = latestOptionsRef.current.getEntryVersion?.(id)
        if (version !== undefined) draftBaseVersionsRef.current[id] = version
      }
      setDrafts((prev) => {
        if (!(id in prev)) return prev
        // A new object even when the draft stays, so its new base version is persisted.
        if (!equal(prev[id], sent)) return { ...prev }
        const next = { ...prev }
        delete next[id]
        return next
      })
      setLoadedValues((prev) => ({ ...prev, [id]: saved }))
      if (timedOutSavesRef.current.delete(id)) notifications.hide(saveTimedOutToastId(id))
      hideEntryGone(id)
    }

    try {
      const saved = await saveEntry(entry, sent)
      // Another branch's state now: its loaded values and draft bases are not this write's.
      if (!onBranch()) return undefined
      commitSaved(saved)
      return { saved: true }
    } catch (err) {
      console.error(err)
      if (!onBranch()) return undefined
      const outcome = classifySaveAllError(err, timedOutSavesRef.current.has(id))
      switch (outcome.kind) {
        case 'unanswered': {
          const landed = await settleUnansweredSave(entry, sent)
          if (!onBranch()) return undefined
          if (landed) {
            commitSaved(landed)
            return { saved: true }
          }
          timedOutSavesRef.current.add(id)
          return fail('unanswered', SAVE_ALL_REASONS.unanswered)
        }
        case 'landed?':
          reloadRequiredRef.current[id] = getEntryVersion?.(id)
          timedOutSavesRef.current.delete(id)
          notifications.hide(saveTimedOutToastId(id))
          return fail('unanswered', SAVE_ALL_REASONS.earlierUnanswered)
        case 'gone': {
          if (timedOutSavesRef.current.delete(id)) notifications.hide(saveTimedOutToastId(id))
          let moved: EditorEntry | undefined
          try {
            moved = await latestOptionsRef.current.followMovedEntry?.(entry)
          } catch (followErr) {
            console.error(followErr)
            return fail('conflict', SAVE_ALL_REASONS.goneUnchecked)
          }
          // "Open" in the result goes to where the changes moved.
          if (moved) return fail('conflict', SAVE_ALL_REASONS.renamed, { path: moved.path })
          return fail('conflict', SAVE_ALL_REASONS.deleted, {
            recreate: () => void recreateGoneEntry(entry, branch),
          })
        }
        default:
          if (outcome.kind === 'invalid' && id === currentIdRef.current) {
            const fieldErrors = err instanceof SaveApiError ? err.fieldErrors : undefined
            if (fieldErrors?.length) {
              setErrorState({ entryId: id, errors: toFieldErrorMap(fieldErrors) })
            }
          }
          return fail(outcome.kind, outcome.reason)
      }
    }
  }

  const handleSaveAll = async (): Promise<SaveAllResult | undefined> => {
    // A Save in flight would race this run's write of the same entry, with the same token.
    if (saveAllRunningRef.current || singleSaveRef.current) return undefined
    saveAllRunningRef.current = true
    const branch = options.branchName
    // Busy from the first moment, so Save waits through the draft check too.
    options.setBusy(true)
    setSaveInFlight(true)
    setSaveAllProgress({ done: 0, total: latestRef.current.modifiedCount })
    try {
      // A restored draft identical to the server is not a change, so it isn't saved.
      await whenDraftsVerified()
      if (latestOptionsRef.current.branchName !== branch) return undefined
      const { dirtyIds: ids, entryById: byId } = latestRef.current
      const current = currentIdRef.current
      const queue = [...ids]
        .sort((a, b) => Number(b === current) - Number(a === current))
        .flatMap((id) => {
          const entry = byId.get(id)
          return entry ? [entry] : []
        })
      const result: SaveAllResult = { branch, total: queue.length, saved: [], failed: [] }
      if (queue.length === 0) return result
      clearSaveAllResult()
      setSaveAllProgress({ done: 0, total: queue.length })
      for (const [index, entry] of queue.entries()) {
        if (latestOptionsRef.current.branchName !== branch) return undefined
        const outcome = await saveOneOfAll(entry, branch)
        if (outcome?.saved) {
          result.saved.push({ contentId: entry.contentId, label: entry.label, path: entry.path })
        } else if (outcome) {
          result.failed.push(outcome.failure)
        }
        setSaveAllProgress({ done: index + 1, total: queue.length })
      }
      if (latestOptionsRef.current.branchName !== branch) return undefined
      // Discarded mid-run, so neither saved nor failed.
      result.total = result.saved.length + result.failed.length
      if (result.saved.length > 0) latestOptionsRef.current.onSaved?.()
      return result
    } finally {
      saveAllRunningRef.current = false
      setSaveAllProgress(null)
      setSaveInFlight(false)
      options.setBusy(false)
    }
  }

  const performDiscardDrafts = () => {
    for (const id of timedOutSavesRef.current) notifications.hide(saveTimedOutToastId(id))
    timedOutSavesRef.current.clear()
    for (const id of goneEntriesRef.current) notifications.hide(entryGoneToastId(id))
    goneEntriesRef.current.clear()
    clearSaveAllResult()
    options.onDraftsReset?.()
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
  const handleDiscardDrafts = (returnFocusTo?: () => HTMLElement | null) => {
    if (modifiedCount === 0) {
      performDiscardDrafts()
      return
    }
    openConfirm({
      title: 'Discard all changes',
      children: `Discard unsaved changes for ${modifiedCount} ${modifiedCount === 1 ? 'entry' : 'entries'}? They will be lost.`,
      labels: { confirm: 'Discard all changes', cancel: 'Cancel' },
      confirmProps: { color: 'red', 'data-testid': 'confirm-discard-all' },
      onConfirm: performDiscardDrafts,
      ...focusReturnProps(returnFocusTo),
    })
  }

  const performDiscardFileDraft = (announce = false) => {
    const entry = options.currentEntry
    if (!entry || !currentId) return
    if (announce) {
      notifications.show({
        message: `Unsaved changes to "${entry.label}" discarded`,
        color: 'green',
      })
    }
    options.onDraftsReset?.(currentId)
    hideEntryGone(currentId)
    settleSaveAllEntry(currentId)
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
      console.warn('Failed to clear draft for entry', err)
    }
  }

  // Only prompt when there is a real draft that actually differs from the
  // loaded value (`isSelectedDirty()` below uses the exact same deep-equal
  // comparison as `modifiedCount`). Discarding a draft that's identical to
  // the loaded value, or discarding when there's no draft at all, has
  // nothing to lose, so it clears silently.
  const handleDiscardFileDraft = (
    returnFocusTo?: () => HTMLElement | null,
    { announce = false }: { announce?: boolean } = {},
  ) => {
    if (!currentId) return
    if (!isSelectedDirty()) {
      performDiscardFileDraft(announce)
      return
    }
    const label = options.currentEntry?.label
    openConfirm({
      title: label ? `Discard changes to "${label}"?` : 'Discard changes?',
      children: 'Your unsaved changes to this entry will be lost.',
      labels: { confirm: 'Discard changes', cancel: 'Keep editing' },
      confirmProps: { color: 'red', 'data-testid': 'confirm-discard-entry' },
      onConfirm: () => performDiscardFileDraft(announce),
      ...focusReturnProps(returnFocusTo),
    })
  }

  const performReload = async () => {
    if (!options.currentEntry || !currentId) return
    options.setBusy(true)
    try {
      const loaded = await options.loadEntry(options.currentEntry)
      options.onDraftsReset?.(currentId)
      delete reloadRequiredRef.current[currentId]
      notifications.hide(saveMayHaveLandedToastId(currentId))
      if (timedOutSavesRef.current.delete(currentId)) {
        notifications.hide(saveTimedOutToastId(currentId))
      }
      hideEntryGone(currentId)
      settleSaveAllEntry(currentId)
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
        message: 'Refreshed from server',
        color: 'blue',
        autoClose: getNotificationDuration(3000),
        withCloseButton: true,
      })
    } catch (err) {
      if (err instanceof EntrySchemaUnavailableError) {
        notifications.show({
          title: 'Not available yet',
          message: err.message,
          color: 'yellow',
          autoClose: getNotificationDuration(8000),
          withCloseButton: true,
        })
        return
      }
      console.error(err)
      notifications.show({
        message: "Couldn't refresh from the server. Your changes are still here; try again.",
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
  const handleReload = async (returnFocusTo?: () => HTMLElement | null) => {
    if (!options.currentEntry || !currentId) return
    if (!isSelectedDirty()) {
      await performReload()
      return
    }
    openConfirm({
      title: 'Refresh from server',
      children:
        "Replace this entry with the server's copy? Unsaved changes to this entry will be lost.",
      labels: { confirm: 'Refresh', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void performReload()
      },
      ...focusReturnProps(returnFocusTo),
    })
  }

  const isDirtyForEntry = (entryPath: string): boolean => {
    const entry = options.entries.find((e) => e.path === entryPath)
    if (!entry) return false

    const id = entry.contentId
    if (!drafts[id]) return false
    const baseline = loadedValues[id] ?? verifiedBaselines[id]
    return baseline === undefined || !equal(drafts[id], baseline)
  }

  const isSelectedDirty = (): boolean => {
    if (!currentId) return false
    if (!drafts[currentId]) return false
    return !loadedValues[currentId] || !equal(drafts[currentId], loadedValues[currentId])
  }

  // True if ANY counted draft is dirty (see `dirtyIds`). Used for branch-level
  // guards so unsaved work in non-selected entries is not silently discarded.
  const isAnyDirty = (): boolean => modifiedCount > 0

  const whenDraftsVerified = (): Promise<void> => {
    if (latestRef.current.unresolvedCount === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        verifyWaitersRef.current = verifyWaitersRef.current.filter((w) => w !== wake)
        resolve()
      }, VERIFY_WAIT_CAP_MS)
      verifyWaitersRef.current.push(wake)
    })
  }

  const resolveUnsaved = async (): Promise<UnsavedSummary> => {
    await whenDraftsVerified()
    const { modifiedCount: count, editedFiles: files } = latestRef.current
    return { count, labels: files.map((f) => f.label) }
  }

  // An entry's token and draft base move to the stamped version only from the version the stamp
  // replaced: one already behind it stays behind, so the usual conflict check still catches it.
  const applySubmitStamps = (stamped: readonly StampedEntry[]) => {
    const { getEntryVersion, adoptEntryVersion } = latestOptionsRef.current
    const loadedMoved: StampedEntry[] = []
    const draftsMoved: StampedEntry[] = []
    for (const entry of stamped) {
      if (getEntryVersion?.(entry.contentId) === entry.previousVersion) {
        adoptEntryVersion?.(entry.contentId, entry.version)
        loadedMoved.push(entry)
      }
      if (draftBaseVersionsRef.current[entry.contentId] === entry.previousVersion) {
        draftBaseVersionsRef.current[entry.contentId] = entry.version
        draftsMoved.push(entry)
      }
    }
    if (loadedMoved.length > 0) {
      setLoadedValues((prev) => {
        const next = { ...prev }
        for (const { contentId, fields } of loadedMoved) {
          if (prev[contentId]) next[contentId] = { ...prev[contentId], ...fields }
        }
        return next
      })
    }
    // A new drafts object even when no value changes, so the moved base versions are persisted.
    if (draftsMoved.length > 0) {
      setDrafts((prev) => {
        const next = { ...prev }
        for (const { contentId, fields } of draftsMoved) {
          const draft = prev[contentId]
          if (!draft) continue
          const filled = { ...draft }
          for (const [name, value] of Object.entries(fields)) {
            if (draft[name] === undefined || draft[name] === null || draft[name] === '') {
              filled[name] = value
            }
          }
          next[contentId] = filled
        }
        return next
      })
    }
  }

  return {
    applySubmitStamps,
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
    handleSaveAll,
    saveAllProgress,
    handleDiscardDrafts,
    handleDiscardFileDraft,
    handleReload,
    isDirtyForEntry,
    isSelectedDirty,
    isAnyDirty,
    whenDraftsVerified,
    resolveUnsaved,
    fieldErrors,
    draftStorageFailed,
  }
}
