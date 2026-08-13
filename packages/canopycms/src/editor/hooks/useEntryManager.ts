import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'
import type { WriteContentBody } from '../../api/content'
import type { EditorEntry, EditorCollection } from '../Editor'
import type { LogicalPath } from '../../paths/types'
import type { FormValue } from '../FormRenderer'
import { buildWritePayload, normalizeContentPayload } from '../editor-utils'
import { isDataOnlyFormat } from '../../utils/format'
import { getErrorMessage } from '../../utils/error'
import type { EntryFieldError } from '../../validation/entry-validator'
import { useApiClient } from '../context'
import { entriesKey, fetchEntriesAndSchema } from './useEntriesData'

// Re-exported so existing imports of `listAllEntries` from this module keep
// working -- the implementation lives in useEntriesData.ts alongside the
// other fetch/key/type pieces useEntryManager shares with the SWR layer.
export { listAllEntries } from './useEntriesData'

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
  /**
   * Entry-type schema names available on this branch, from the same schema
   * fetch that builds `collections`/`entries`. Exposed here so Editor.tsx's
   * schema-editor "available schemas" list doesn't need its own separate
   * fetch of the same schema endpoint.
   */
  availableSchemas: string[]
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
  /**
   * Slugs already taken in `createModalCollection`, derived from the
   * already-loaded `entries` list. Lets the create modal reject an obvious
   * collision client-side with a clear message, before ever hitting the
   * server's authoritative 409 guard (August 2026 baseline review).
   */
  createModalExistingSlugs: Set<string>
  handleCreateModalSubmit: (slug: string, entryTypeName: string) => Promise<void>
  closeCreateModal: () => void
}

/**
 * One branch's fetched view, stamped with the branch that produced it so a
 * stale record can never be rendered under a different branch. Committed
 * atomically -- the three fields always describe the same fetch.
 */
interface BranchView {
  branch: string
  entries: EditorEntry[]
  collections: EditorCollection[]
  availableSchemas: string[]
}

// Module-level singletons for the derived-empty fallbacks. These must be
// referentially stable: `collectionByPath` and `currentEntry` memoize on them,
// and a fresh `[]` each render would invalidate both on every render while a
// branch's data is in flight. Never mutate them.
const EMPTY_ENTRIES: EditorEntry[] = []
const EMPTY_COLLECTIONS: EditorCollection[] = []
const EMPTY_SCHEMAS: string[] = []

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
  const { mutate: globalMutate } = useSWRConfig()
  // The fetched view of ONE branch, committed as a single record stamped with
  // the branch it came from. Everything below derives from it and falls back to
  // empty whenever the stamp doesn't match the branch currently being shown, so
  // another branch's content is unrenderable by construction.
  //
  // This replaced three independent mirrors (entries/collections/
  // availableSchemas), which were only ever reset by a SUCCESSFUL commit. Every
  // early return in the commit effect below therefore left the previous
  // branch's data on screen: no cached data yet for the new branch (the common
  // case -- any first visit to a branch, for the whole duration of its fetch),
  // or a stale SWR slot. The editor then auto-selected one of those stale
  // entries (see the selection effect below), and a save could file its OCC
  // token under one contentId and look it up under another, silently skipping
  // conflict detection -- `content-store.ts` only compares mtimes when
  // `expectedVersion !== undefined`, so the write became a blind overwrite.
  // Deriving from a stamped record fixes that structurally instead of relying
  // on every code path remembering to clear.
  const [view, setView] = useState<BranchView>(() => ({
    branch: options.branchName,
    entries: options.initialEntries,
    collections: options.collections ?? [],
    availableSchemas: [],
  }))
  const isCurrentBranchView = view.branch === options.branchName
  const entriesState = isCurrentBranchView ? view.entries : EMPTY_ENTRIES
  const collectionsState = isCurrentBranchView ? view.collections : EMPTY_COLLECTIONS
  const availableSchemas = isCurrentBranchView ? view.availableSchemas : EMPTY_SCHEMAS

  // Exposed as `setEntries` (see the return value). Merges rather than
  // replaces -- a bare record write would wipe `collections`/
  // `availableSchemas` -- and never grafts another branch's collections under
  // the current branch's stamp.
  const setEntries = (entries: EditorEntry[]) => {
    setView((prev) =>
      prev.branch === options.branchName
        ? { ...prev, entries }
        : { branch: options.branchName, entries, collections: [], availableSchemas: [] },
    )
  }

  // Initialize with prop value or empty (URL sync happens in effect after mount)
  const [selectedPath, setSelectedPath] = useState<string>(options.initialSelectedId ?? '')
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const isInitialMount = useRef(true)
  const hasSyncedFromUrl = useRef(false)
  // OCC version tokens — captured on load, sent on save. Keyed by
  // `${branch}:${contentId}`, NOT contentId alone: the token is a file mtime,
  // which is inherently per-branch (each branch clone has its own file). With
  // a branch-agnostic key, a late-resolving load response from the PREVIOUS
  // branch can repopulate the map after the branch-change clear() below and
  // poison the next save with the old branch's mtime — a deterministic 409
  // ("modified by another editor") on save-after-switch, proven by e2e trace.
  const entryVersionsRef = useRef<Map<string, number>>(new Map())
  const versionKey = (branch: string, contentId: string) => `${branch}:${contentId}`
  // PER-BRANCH monotonic tokens guarding every commit of the fetched
  // `BranchView` record above, shared by BOTH the automatic SWR-backed load
  // (below) and explicit `refreshEntries()` calls. Two maps, keyed by branch:
  //
  // - `claimed`: bumped the moment an attempt's request starts; the value is
  //   baked into that attempt's result tag.
  // - `committed`: the tag seq currently REFLECTED IN STATE for that branch.
  //
  // The commit rule is `tag.seq >= committed(tag.branch)` -- "never move a
  // branch's view backwards" -- NOT `tag.seq === claimed(tag.branch)`
  // ("newest attempt wins"). The difference matters twice:
  //
  // 1. SWR replays a branch's CACHED tagged result when the user switches
  //    back to it, and the cached tag necessarily carries the seq claimed
  //    when that data was originally fetched. Under a newest-attempt rule
  //    (or a single GLOBAL counter, as originally shipped), any newer claim
  //    -- another branch's load with a global counter, or the switch-back's
  //    own revalidation with a per-branch one -- made the replayed,
  //    perfectly valid cache hit fail the check and never commit; when the
  //    switch back also landed inside SWR's dedupingInterval, no
  //    revalidation followed either, so the editor kept showing the
  //    PREVIOUS branch's entries under the new branch indefinitely. A
  //    replayed tag always passes the committed-seq rule (it was committed
  //    before, or is newer than what was).
  // 2. On remount these refs reset to empty maps while SWR's cache (owned by
  //    the provider above this component) survives, so a replayed tag can
  //    carry a seq higher than anything this instance ever claimed -- still
  //    the newest data known for that branch, and still committable. Note the
  //    cache now belongs to `SWRProvider`'s own `provider` Map rather than
  //    SWR's module global, so "survives" means across remounts BELOW
  //    `CanopyEditor`; remounting `CanopyEditor` itself starts a fresh cache,
  //    which is the same empty-cache path as a first load.
  //
  // What the committed-seq rule gives up: when two same-branch attempts race
  // and the OLDER response arrives second while the newer is still in
  // flight, the older commits transiently and the newer overwrites it on
  // settle (a sub-second flash of slightly-stale data, converging to the
  // newest). A response older than what's already displayed is still
  // rejected outright. Cross-branch bleed is prevented separately: every
  // commit site checks the tag's branch against options.branchName at
  // settle time.
  const refreshSeqRef = useRef<{ claimed: Map<string, number>; committed: Map<string, number> }>({
    claimed: new Map(),
    committed: new Map(),
  })
  const claimRefreshSeq = (branch: string): number => {
    const next = (refreshSeqRef.current.claimed.get(branch) ?? 0) + 1
    refreshSeqRef.current.claimed.set(branch, next)
    return next
  }
  const committedRefreshSeq = (branch: string): number =>
    refreshSeqRef.current.committed.get(branch) ?? 0
  // The branch currently shown, readable at SETTLE time from async closures
  // that captured an older render's `options` (refreshEntries below runs
  // across renders; its captured options.branchName goes stale the moment
  // the user switches mid-flight, which is exactly when the check matters).
  const currentBranchRef = useRef(options.branchName)
  currentBranchRef.current = options.branchName
  const recordCommittedRefreshSeq = (branch: string, seq: number): void => {
    refreshSeqRef.current.committed.set(branch, seq)
    // A commit also implies any future claim must outrank this tag, so a
    // replayed high-seq tag (remount case above) keeps ordering coherent.
    if ((refreshSeqRef.current.claimed.get(branch) ?? 0) < seq) {
      refreshSeqRef.current.claimed.set(branch, seq)
    }
  }

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

  // Slugs already used within the collection currently open in the create
  // modal. Collision is keyed on collectionPath + slug only (not entryType):
  // ContentStore resolves an existing entry by slug alone within a
  // collection, regardless of which entry type the create form has selected.
  const createModalExistingSlugs = useMemo(() => {
    if (!createModalCollection) return new Set<string>()
    return new Set(
      entriesState
        .filter((e) => e.collectionPath === createModalCollection.path && e.slug)
        .map((e) => e.slug as string),
    )
  }, [entriesState, createModalCollection])

  const loadEntry = async (entry: EditorEntry) => {
    if (!entry.collectionPath) {
      throw new Error('Entry missing collectionPath')
    }
    // Pin the branch this request targets: if the user switches branches
    // while the read is in flight, the token must be recorded under the
    // branch that actually served it, not the current one.
    const requestBranch = options.branchName
    // Build path from collectionPath and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionPath}/${entry.slug}` : entry.collectionPath
    const result = await apiClient.content.read({
      branch: requestBranch,
      path,
    })
    if (!result.ok) throw new Error(`Load failed: ${result.status}`)
    // Capture OCC version token for next save
    if (entry.contentId && typeof result.data?.version === 'number') {
      entryVersionsRef.current.set(versionKey(requestBranch, entry.contentId), result.data.version)
    }
    return normalizeContentPayload(result.data)
  }

  const saveEntry = async (entry: EditorEntry, value: FormValue) => {
    if (!entry.collectionPath) {
      throw new Error('Entry missing collectionPath')
    }
    const payload = buildWritePayload(entry, value)
    // Pin the branch this save targets (same rationale as loadEntry): the
    // token lookup and the write must agree on the branch even if a switch
    // lands mid-flight.
    const requestBranch = options.branchName
    // Build path from collectionPath and slug (if it's a collection entry)
    const path = entry.slug ? `${entry.collectionPath}/${entry.slug}` : entry.collectionPath
    const writeParams: { branch: string; path: string; entryType?: string } = {
      branch: requestBranch,
      path,
    }
    if (entry.entryType) writeParams.entryType = entry.entryType
    const expectedVersion = entry.contentId
      ? entryVersionsRef.current.get(versionKey(requestBranch, entry.contentId))
      : undefined
    const writeBody: WriteContentBody = {
      ...(payload as unknown as WriteContentBody),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    }
    const result = await apiClient.content.write(writeParams, writeBody)
    if (!result.ok) throw new SaveApiError(result.status, result.error, result.fieldErrors)
    // Update stored version token from write response
    if (entry.contentId && typeof result.data?.version === 'number') {
      entryVersionsRef.current.set(versionKey(requestBranch, entry.contentId), result.data.version)
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

  // Explicit reload: always issues a fresh, independent fetch (never
  // deduped/coalesced against an in-flight automatic load) so callers that
  // just mutated content (save, create, rename, schema change) are
  // guaranteed to see their own write reflected. Seq-guarded per the
  // refreshSeqRef doc comment above; also warms the SWR cache for `branch`
  // so a later automatic re-fetch of the same key (e.g. switching away and
  // back) can reuse it instead of refetching.
  const refreshEntries = async (branch: string = options.branchName): Promise<EditorEntry[]> => {
    if (!branch) return []
    const seq = claimRefreshSeq(branch)
    const fetched = await fetchEntriesAndSchema(apiClient, branch, {
      resolvePreviewSrc: options.resolvePreviewSrc,
      contentRoot: options.contentRoot,
    })
    if (seq >= committedRefreshSeq(branch)) {
      // Warm the SWR cache for this branch (it's this branch's own slot, so
      // a later switch back can replay it), but only commit component state
      // when the user is still ON this branch at settle time -- with
      // per-branch seqs, a branch switch no longer advances the old
      // branch's counter, so this check is what stops a late refresh of the
      // switched-away branch from overwriting the new branch's view.
      void globalMutate(entriesKey(branch), { fetched, seq, branch }, { revalidate: false })
      if (branch === currentBranchRef.current) {
        recordCommittedRefreshSeq(branch, seq)
        setView({ branch, ...fetched })
      }
    }
    return fetched.entries
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

      // expectedVersion: null is the create-intent signal the server
      // enforces authoritatively (see content-store.ts's write() OCC block
      // and api/content.ts's writeContentHandler) -- "this slug must not
      // already exist yet". Without it a create is indistinguishable from a
      // blind update, which used to let a same-slug create silently
      // overwrite existing content (August 2026 baseline review).
      const payload = isDataOnlyFormat(format)
        ? { format: format as 'json' | 'yaml', data: {}, expectedVersion: null }
        : { format, data: {}, body: '', expectedVersion: null }

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

  // Clear selection when branch changes (reactive pattern). Data loading
  // itself is handled below by the SWR-backed fetch -- this effect only
  // owns the "clear stale selection" side effect.
  useEffect(() => {
    if (!options.branchName) return
    // On initial mount, preserve the initial selection from URL
    // On subsequent branch changes, clear selection
    if (isInitialMount.current) {
      isInitialMount.current = false
    } else {
      setSelectedPath('')
      // Bound version-map growth across switches. Correctness no longer
      // depends on this clear: tokens are keyed by `${branch}:${contentId}`
      // (see entryVersionsRef), so a late response from the previous branch
      // can't poison the new branch's saves even if it lands after this.
      entryVersionsRef.current.clear()
    }
  }, [options.branchName])

  // Automatic schema + entries load, keyed per branch. SWR dedupes
  // concurrent mounts of the same key (e.g. React Strict Mode's double
  // effect invoke) into a single request. `entriesSwrKey` is null when
  // there's no branch yet, which pauses fetching entirely.
  //
  // The fetcher tags its result with a `refreshSeqRef` token the moment the
  // underlying request actually starts, so this automatic load and any
  // explicit `refreshEntries()` call race-guard against EACH OTHER through
  // the same shared counter (see the doc comment on refreshSeqRef above) --
  // not just against other automatic loads.
  const entriesSwrKey = options.branchName ? entriesKey(options.branchName) : null
  const {
    data: taggedEntries,
    error: entriesError,
    isLoading: entriesIsLoading,
    isValidating: entriesIsValidating,
  } = useSWR(entriesSwrKey, () => {
    // Claim the seq token synchronously, the instant the underlying request
    // actually starts -- matching how the explicit refreshEntries() path
    // claims it (before its first await) -- so races between the two are
    // ordered by when each attempt STARTED, not by unrelated differences in
    // how many microtask hops SWR's own dispatch machinery adds before the
    // fetcher body runs.
    const branch = options.branchName
    const seq = claimRefreshSeq(branch)
    return fetchEntriesAndSchema(apiClient, branch, {
      resolvePreviewSrc: options.resolvePreviewSrc,
      contentRoot: options.contentRoot,
    }).then((fetched) => ({ fetched, seq, branch }))
  })

  // Commit the current branch's tagged data -- both fresh settles AND SWR
  // cache replays on a switch back to a previously visited branch (the
  // effect re-runs on options.branchName so the replayed tag, whose object
  // identity didn't change, still gets (re)committed). The seq comparison is
  // the per-branch committed-seq rule -- see refreshSeqRef's doc comment for
  // why it is not "newest claim wins" and why a global counter broke cached
  // replays. The branch check keeps a tag from ever committing under a
  // different branch's view.
  useEffect(() => {
    if (!taggedEntries) return
    if (taggedEntries.branch !== options.branchName) return
    if (taggedEntries.seq < committedRefreshSeq(taggedEntries.branch)) {
      // The cached tag for the CURRENT branch is older than what this
      // instance already displayed for it (e.g. a slow automatic load's
      // settle overwrote the SWR slot after a newer explicit refresh
      // committed). State already shows newer data, so don't regress it --
      // but the SWR slot is stale now, so ask for a revalidation; inside
      // the dedupingInterval nothing else would refresh this key.
      void globalMutate(entriesKey(taggedEntries.branch))
      return
    }
    recordCommittedRefreshSeq(taggedEntries.branch, taggedEntries.seq)
    setView({ branch: taggedEntries.branch, ...taggedEntries.fetched })
    // Deps: only the tag and the current branch matter; the seq helpers and
    // globalMutate are stable. (This file is plain .ts, so the
    // react-hooks/exhaustive-deps rule isn't active here anyway -- same note
    // as useCommentSystem.ts.)
  }, [taggedEntries, options.branchName])

  // Mirrors the automatic load's in-flight state onto the shared busy flag.
  // Explicit refreshEntries() calls intentionally do NOT toggle this (they
  // never did, pre-SWR) -- callers that need a busy indicator around an
  // explicit refresh (e.g. renameEntry) already bracket setBusy themselves.
  useEffect(() => {
    options.setBusy(entriesIsValidating)
  }, [entriesIsValidating, options.setBusy])

  // True while the current branch's entries are not yet on screen. Lets the empty editor pane
  // show "Loading…" instead of briefly flashing "Select an item…". Each branch has its own SWR
  // cache slot, so this is naturally per-branch.
  //
  // `!isCurrentBranchView` is part of the condition, not just `isLoading`: SWR reports
  // `isLoading: false` whenever ANY cached data exists for the key, and the committed record
  // can also lag a settled fetch by a render. Without it there would be a window that is
  // simultaneously "showing nothing" and "not loading".
  //
  // `!entriesError` is what keeps that window from becoming permanent. The provider sets
  // `shouldRetryOnError: false`, so a failed load never resolves on its own: the stamp would
  // never match, and the pane would sit at "Loading content…" forever with no retry
  // affordance. On error we fall through to the normal empty state, and the effect below
  // says what happened.
  const entriesInitializing =
    Boolean(options.branchName) && !entriesError && (entriesIsLoading || !isCurrentBranchView)

  // Surface a failed automatic load. The pre-SWR code showed a notification and logged once
  // per failure; the SWR migration dropped that, and since `shouldRetryOnError` is false the
  // failure is terminal until something else revalidates the key -- so without this the editor
  // would just show an empty content tree with no explanation. Keyed by branch (switching
  // branches can report a fresh failure) and cleared whenever there's no error, so returning
  // to a branch that fails again still reports.
  const notifiedErrorBranchRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entriesError || !options.branchName) {
      notifiedErrorBranchRef.current = null
      return
    }
    if (notifiedErrorBranchRef.current === options.branchName) return
    notifiedErrorBranchRef.current = options.branchName
    console.error(entriesError)
    notifications.show({
      title: 'Could not load content',
      message: getErrorMessage(entriesError),
      color: 'red',
    })
  }, [entriesError, options.branchName])

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
    setEntries,
    collections: collectionsState,
    currentEntry,
    availableSchemas,
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
    createModalExistingSlugs,
    handleCreateModalSubmit,
    closeCreateModal,
  }
}
