'use client'

import React, { useEffect, useMemo, useState, useRef } from 'react'

import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Menu,
  Paper,
  Skeleton,
  Stack,
  Text,
  Tooltip,
  useTree,
} from '@mantine/core'
import {
  IconChevronDown,
  IconChevronUp,
  IconDots,
  IconFolderPlus,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react'
import { useMediaQuery } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'

type TreeController = ReturnType<typeof useTree>

const noop = (): void => {}

import type { ContentFormat, EntrySchema, EntryTypeUnavailable, MdxAllowlist } from '../config'
import { EntryNavigator, type EntryNavCollection } from './EntryNavigator'
import type { CustomFieldRenderers, FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { PreviewPane } from './PreviewPane'
import type { OperatingMode } from '../operating-mode'
import { clientOperatingStrategy } from '../operating-mode/client'
import { EditorShell } from './shell/EditorShell'
import { PaneLayout } from './shell/PaneLayout'
import { SidePanelHost } from './shell/SidePanelHost'
import { CanopyCMSProvider, type CanopyThemeOptions } from './theme'
import { BranchManager } from './BranchManager'
import { BranchesDrawer } from './components/BranchesDrawer'
import { CommentsPanel } from './CommentsPanel'
import { GroupManager } from './GroupManager'
import { PermissionManager } from './PermissionManager'
import { SystemHealthPanel } from './admin/SystemHealthPanel'
// Import directly from helpers to avoid server-only code in authorization barrel
import { isAdmin, isPrivileged, isReviewer } from '../authorization/helpers'
import { fieldBreadcrumb } from './field-breadcrumb'
import type { CommentThread } from '../comment-store'
import {
  buildPreviewRoute,
  buildPreviewSrc,
  buildCollectionLabels,
  entryStatusLabel,
  entryTypeLabel,
  buildBreadcrumbSegments,
} from './editor-utils'
import {
  useEditorLayout,
  useDraftManager,
  useEntryManager,
  useGroupManager,
  usePermissionManager,
  useCommentSystem,
  useBranchManager,
  useUserContext,
  useSchemaManager,
} from './hooks'
import { useBranchActions } from './hooks/useBranchActions'
import type { UnsavedSummary } from './hooks/useDraftManager'
import type { StampedEntry } from '../stamp-on-publish'
import {
  CONTENT_PANEL_WIDTH_MAX,
  CONTENT_PANEL_WIDTH_MIN,
  editorLayoutStorageKey,
} from './hooks/useEditorLayout'
import { EntrySchemaUnavailableError } from './hooks/useEntryManager'
import { useEntryLinkResolution } from './hooks/useEntryLinkResolution'
import { useReferenceResolution } from './hooks/useReferenceResolution'
import { usePreviewMarks } from './hooks/usePreviewMarks'
import { BranchLockBanner, EditorHeader, EditorRail } from './components'
import { RenameEntryModal } from './components/RenameEntryModal'
import { QuickOpenPalette } from './components/QuickOpenPalette'
import { rememberOpener, returnTarget } from './utils/focus-return'
import { modKeyLabel } from './platform'
import { EDITOR_ACTIONS } from './copy'
import { EntryCreateModal, type EntryType } from './components/EntryCreateModal'
import { ConfirmDeleteModal } from './components/ConfirmDeleteModal'
import { ReferencedByList, referencedDeleteMessage } from './components/ReferencedByList'
import type { EntryReferencedBy } from '../api/entries'
import { NoEditPermissionNotice } from './components/NoEditPermissionNotice'
import { ReadOnlyDraftNotice } from './components/ReadOnlyDraftNotice'
import { UnavailableEntryNotice } from './components/UnavailableEntryNotice'
import { unavailableSchemaRefs } from './unavailable-entry-type'
import { EditorCrashBoundary } from './components/EditorCrashScreen'
import {
  CollectionEditor,
  type ExistingCollection,
  type ExistingEntryType,
  type RestoredCollectionInput,
} from './schema-editor'
import { collectionDraftLanded, type CollectionDraft } from './schema-editor/collection-draft'
import { hideCollectionOutcomeUnknown } from './hooks/useSchemaManager'
import type { LogicalPath, ContentId } from '../paths/types'
import {
  AssetContextProvider,
  SiteMdxAllowContext,
  authenticatedAssetBase,
  useApiClient,
} from './context'
import { EntryLinkContext, type EntryLinkOption } from './fields/entry-link'
import { MediaLibrary } from './media/MediaLibrary'
import {
  removalAnchors,
  restoreRemoval,
  openThreadsWithin,
  restoredFieldPath,
  type FieldRemoval,
} from './undo-removal'
import { formatCanopyPath } from './canopy-path'
import { itemKeysOnPath, resolveThreadPath, withItemKeys } from '../item-keys'
import {
  ENTRY_NOT_LOADED_COMMENT_MESSAGE,
  NEW_ITEM_COMMENT_MESSAGE,
} from './comments/item-anchor-copy'
import { findFieldTarget, focusFieldTarget } from './field-target'
import { UndoToastMessage } from './components/UndoToastMessage'
import { getNotificationDuration } from './utils/env'
import { MayHaveLandedError } from './unanswered'

export interface EditorEntry {
  path: LogicalPath // Logical path (no IDs/extensions)
  contentId: ContentId // 12-char content ID (required - used for draft keying)
  label: string
  status?: string
  schema: EntrySchema
  previewSrc?: string
  collectionPath?: LogicalPath
  collectionName?: string
  slug?: string
  format?: ContentFormat
  entryType?: string // Entry type name (e.g. 'post', 'settings') — used when saving to collections with multiple types
  type?: 'entry'
  canEdit?: boolean
  /** Set when the entry's type has no schema in the running code; `schema` is then empty. */
  unavailable?: EntryTypeUnavailable
}

/**
 * Summary of an entry type for UI display.
 * Contains just enough info to show type picker and create entries.
 */
export interface EditorEntryType {
  name: string
  label?: string
  format: ContentFormat
  default?: boolean
  maxItems?: number
  /** Set when the type has no schema in the running code; it cannot be created or edited. */
  unavailable?: EntryTypeUnavailable
  /** Data path of the field that titles an entry of this type; the create form asks for it first. */
  titleField?: readonly string[]
}

export interface EditorCollection {
  path: LogicalPath // Logical path
  contentId?: ContentId // 12-char content ID (optional, from directory name)
  name: string
  label?: string
  format: ContentFormat // Default entry type's format (for backwards compatibility)
  type: 'collection' | 'entry'
  entryTypes?: EditorEntryType[] // All entry types in this collection
  order?: readonly string[] // Embedded IDs for ordering entries and children
  children?: EditorCollection[]
  /** False when this user's path permissions refuse a new entry here (the entries listing). */
  canAddEntry?: boolean
}

export interface EditorProps {
  entries: EditorEntry[]
  title: string
  subtitle?: string
  siteTitle?: string
  siteSubtitle?: string
  branchName?: string
  operatingMode: OperatingMode
  collections?: EditorCollection[]
  contentRoot?: string
  entryLinkUrl?: import('../entry-link-resolver').EntryLinkUrlResolver
  initialSelectedId?: string
  initialValues?: Record<string, FormValue>
  renderPreview?: (entry: EditorEntry, value: FormValue | undefined) => React.ReactNode
  onCreateEntry?: (collectionPath: LogicalPath) => Promise<void> | void
  themeOptions?: CanopyThemeOptions
  /** `editor.previewBase` from config (see `buildPreviewSrc`); `false` marks entries with no page. */
  previewBaseByCollection?: Record<string, string | false>
  /** `editor.previewPrefix` from config: put in front of every preview iframe `src` (see `buildPreviewSrc`). */
  previewPrefix?: string
  /** `mdxAllow` from config: what fields checked as MDX accept, so the toolbar writes nothing else. */
  mdxAllow?: MdxAllowlist
  currentUser?: string
  canResolveComments?: boolean
  /**
   * `CanopyClientConfig.basePath` - the deployment prefix the host Next.js app is served under
   * (e.g. `/preview-123`). Prefixed onto every preview iframe `src` this component builds via
   * `buildPreviewSrc`, so the iframe navigates to the entry's real served URL instead of the
   * un-prefixed root. Undefined means the app is served at its origin's root (no-op).
   */
  basePath?: string
  /**
   * Adopter-supplied overrides for how specific field types render, keyed by
   * field `type` (see `FormRenderer`'s `customRenderers` prop). Threaded
   * straight through to `FormRenderer` so this documented extension point is
   * reachable from the public `CanopyEditor`/`CanopyEditorPage` surface, not
   * just from a direct `FormRenderer` usage.
   */
  customRenderers?: CustomFieldRenderers
  AccountComponent?: React.ComponentType
  onAccountClick?: () => void
  onLogoutClick?: () => void
}

// Stable fallbacks, so reference resolution's memo and effect don't re-run on every render
// while no entry is open.
const EMPTY_SCHEMA: EntrySchema = []
const CONTENT_PANEL_ID = 'canopy-content-panel'
const EMPTY_VALUE: FormValue = {}

/**
 * High-level editor wrapper that wires entry navigation, form rendering,
 * saving/loading, and preview rendering using entry definitions.
 */
export const Editor: React.FC<EditorProps> = (props) => (
  <EditorCrashBoundary themeOptions={props.themeOptions}>
    <EditorContent {...props} />
  </EditorCrashBoundary>
)

const EditorContent: React.FC<EditorProps> = ({
  entries,
  title,
  subtitle,
  siteTitle = title,
  siteSubtitle = subtitle,
  branchName = '',
  collections,
  contentRoot,
  entryLinkUrl,
  initialSelectedId,
  initialValues,
  renderPreview,
  onCreateEntry,
  themeOptions,
  operatingMode,
  previewBaseByCollection,
  previewPrefix,
  mdxAllow,
  currentUser = 'current-user',
  canResolveComments = true,
  basePath,
  AccountComponent,
  onAccountClick,
  onLogoutClick,
  customRenderers,
}) => {
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [commentsLoading] = useState(false)
  const busy = branchesLoading || entriesLoading || commentsLoading

  const [groupManagerOpen, setGroupManagerOpen] = useState(false)
  const [permissionManagerOpen, setPermissionManagerOpen] = useState(false)
  const [branchManagerOpen, setBranchManagerOpen] = useState(false)
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false)
  const [systemHealthOpen, setSystemHealthOpen] = useState(false)

  const [collectionEditorOpen, setCollectionEditorOpen] = useState(false)
  const [editingCollection, setEditingCollection] = useState<ExistingCollection | null>(null)
  const [collectionEditorParentPath, setCollectionEditorParentPath] = useState<
    LogicalPath | undefined
  >(undefined)
  const [collectionEditorError, setCollectionEditorError] = useState<string | null>(null)
  // What the last unanswered collection create or details save sent, until its dialog's opener
  // sees it land on a fresh read, a matching save succeeds, or the user discards it.
  const collectionDraftRef = useRef<CollectionDraft | null>(null)
  // The draft the open dialog was filled from, if any: its save replaces that draft.
  const refilledDraftRef = useRef<CollectionDraft | null>(null)
  // What the dialog fills in, decided by its opener against a fresh tree.
  const [restoredCollectionInput, setRestoredCollectionInput] =
    useState<RestoredCollectionInput | null>(null)
  // Each open or close of the collection dialog moves it on, so a slow open answers only if current.
  const collectionOpeningRef = useRef(0)

  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  const [quickOpenFromOverlay, setQuickOpenFromOverlay] = useState(false)
  const navigatorToggleRef = useRef<HTMLButtonElement>(null)
  const mediaButtonRef = useRef<HTMLButtonElement>(null)
  const branchToggleRef = useRef<HTMLButtonElement>(null)
  const settingsToggleRef = useRef<HTMLButtonElement>(null)
  // Null when the branches drawer opened from a menu item; see `rememberOpener`.
  const branchOpenerRef = useRef<HTMLElement | null>(null)
  // Null when the panel opened from a menu item, which unmounts on click, or with focus on the page.
  const navigatorOpenerRef = useRef<HTMLElement | null>(null)
  const quickOpenOpenRef = useRef(false)
  useEffect(() => {
    quickOpenOpenRef.current = quickOpenOpen
  }, [quickOpenOpen])

  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [renamingEntry, setRenamingEntry] = useState<EditorEntry | null>(null)
  const [renameModalError, setRenameModalError] = useState<{
    message: string
    mayHaveLanded: boolean
  } | null>(null)
  const [renameModalSaving, setRenameModalSaving] = useState(false)

  const [deleteCollectionModalOpen, setDeleteCollectionModalOpen] = useState(false)
  const [deletingCollectionPath, setDeletingCollectionPath] = useState<LogicalPath | null>(null)
  const [deleteEntryModalOpen, setDeleteEntryModalOpen] = useState(false)
  const [deletingEntryPath, setDeletingEntryPath] = useState<LogicalPath | null>(null)
  // Set once the server refuses a delete because other entries reference the entry.
  const [deletingEntryReferencedBy, setDeletingEntryReferencedBy] =
    useState<EntryReferencedBy | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)

  // Draft compile/render error reported by the preview page (null = renders cleanly)
  const [previewError, setPreviewError] = useState<{ message: string; fieldPath?: string } | null>(
    null,
  )

  const apiClient = useApiClient()

  const { userContext } = useUserContext()

  // Admin surfaces (permissions, groups, system health, collection management and entry order,
  // whose API routes all take the `admin` guard) render only for admins: each menu item, action
  // and drawer mount is gated here. Until whoami answers, the user counts as no admin.
  const userIsAdmin = isAdmin(userContext?.groups)
  // Name lookups take the `privileged` guard (admins and reviewers); no lookup is sent that would
  // only be refused. Comment surfaces name their people for everyone (getCommentUserMetadata).
  const canResolveUserNames = isPrivileged(userContext?.groups)
  // Reviewers and admins resolve any thread; everyone else only the threads they started.
  const canResolveAnyComment = canResolveComments && isReviewer(userContext?.groups)
  // The signed-in user, so "started by me" matches the thread authors the server records.
  const commentUserId = userContext?.userId ?? currentUser

  // Below 64em (1024px) the editor starts stacked and the content panel never docks.
  const wideWindow =
    useMediaQuery('(min-width: 64em)', true, { getInitialValueInEffect: false }) !== false
  const {
    loaded: layoutLoaded,
    layout,
    setLayout,
    highlightEnabled,
    setHighlightEnabled,
    sideSplitPercent,
    stackedSplitPercent,
    setSplitPercent,
    previewWidth,
    setPreviewWidth,
    contentPanelOpen,
    setContentPanelOpen,
    contentPanelWidth,
    setContentPanelWidth,
  } = useEditorLayout({
    storageKey: editorLayoutStorageKey(basePath),
    defaultLayout: wideWindow ? 'side' : 'stacked',
  })
  // In the stacked layout the content panel lays over the form only, so the preview stays in view.
  const contentPanelDocked = layout === 'side' && wideWindow

  // Comments state (shared between useCommentSystem and useBranchManager)
  const [commentsForBranchSummaries, setCommentsForBranchSummaries] = useState<CommentThread[]>([])

  // 1. Branch manager (provides branchNameState, no dependencies)
  const resolveUnsavedRef = useRef<() => Promise<UnsavedSummary>>(async () => ({
    count: 0,
    labels: [],
  }))
  const applySubmitStampsRef = useRef<(stamped: readonly StampedEntry[]) => void>(() => {})
  const {
    branchName: branchNameState,
    setBranchName,
    branchSummaries,
    currentBranch,
    addCreatedBranch,
    handleSubmit,
    handleWithdraw,
    handleRequestChanges,
    handleDelete,
    handleReloadBranchData,
    loadBranches,
  } = useBranchManager({
    initialBranch: branchName,
    operatingMode,
    setBusy: setBranchesLoading,
    comments: commentsForBranchSummaries,
    // The draft manager comes later, as it depends on this hook's branch.
    getUnsaved: () => resolveUnsavedRef.current(),
    onStamped: (stamped) => applySubmitStampsRef.current(stamped),
  })

  // Content mutations (add/delete/rename/reorder entries) are locked whenever the
  // server says writes are blocked -- the protected base branch, or a workflow
  // status past 'editing' (submitted for review, approved, archived). The flag is
  // computed server-side by the same getBranchProtection() call the writableBranch
  // guard uses, so the UI can never drift from what the API will accept.
  //
  // `?? true`: with no answer from the server (branches fetch in flight or
  // failed, or an older server without the flag) the editor must stay locked. A
  // brief flash of locked, corrected when the list loads, is safer than a flash
  // of unlocked that invites a click the server rejects -- and the pane shows a
  // loading state during that window anyway.
  const branchContentLocked = currentBranch?.writeBlocked ?? true

  // 2. Entry manager (depends on branchNameState, owns selectedPath)
  const {
    selectedPath,
    setSelectedPath,
    entries: entriesState,
    collections: collectionsFromApi,
    currentEntry,
    availableSchemas,
    entriesInitializing,
    navigatorOpen,
    setNavigatorOpen,
    refreshEntries,
    refreshContent,
    handleCreateEntry,
    renameEntry,
    loadEntry,
    readEntryValue,
    saveEntry,
    getEntryVersion,
    adoptEntryVersion,
    followMovedEntry,
    recreateEntry,
    createModalOpen,
    createModalCollection,
    createModalError,
    createModalCreating,
    createModalExistingSlugs,
    handleCreateModalSubmit,
    closeCreateModal,
  } = useEntryManager({
    initialEntries: entries,
    initialSelectedId,
    branchName: branchNameState,
    collections,
    resolvePreviewSrc: (entry) =>
      buildPreviewSrc(entry, {
        branchName: branchNameState,
        previewBaseByCollection,
        previewPrefix,
        contentRoot,
        basePath,
      }),
    setBusy: setEntriesLoading,
  })

  // The content overlay and a maximized preview hide the form; `navigatorOpen` is only the
  // overlay's. Anything that focuses something in the form reveals it first. Opening an entry
  // closes the overlay only, so the preview stays maximized across entries (see
  // `previewShownMaximized` for the loads in between).
  const [previewMaximized, setPreviewMaximized] = useState(false)
  const revealForm = () => {
    setNavigatorOpen(false)
    setPreviewMaximized(false)
  }
  const openEntry = (path: string) => {
    setSelectedPath(path)
    setNavigatorOpen(false)
  }

  // An open overlay docks open, as the URL's ask for no entry does at load; `navigatorOpen` is only
  // the overlay's, so a docked panel never resurfaces as one. Waits for the stored layout, whose
  // arrival could otherwise dock an overlay the stacked layout keeps.
  useEffect(() => {
    if (layoutLoaded && contentPanelDocked && navigatorOpen) {
      setContentPanelOpen(true)
      setNavigatorOpen(false)
    }
  }, [layoutLoaded, contentPanelDocked, navigatorOpen, setContentPanelOpen, setNavigatorOpen])

  // Keeps the entry-type list referentially stable while the create modal shows
  // the same collection: a new array on every render would churn Mantine's
  // Select `data` identity and give EntryCreateModal's form-seeding effect a
  // spurious reason to reset the user's input.
  const createModalEntryTypes = useMemo<EntryType[]>(
    () =>
      createModalCollection?.entryTypes?.map((et) => ({
        name: et.name,
        label: et.label,
        format: et.format,
        default: et.default,
        maxItems: et.maxItems,
        unavailable: et.unavailable,
        titleField: et.titleField,
      })) ?? [],
    [createModalCollection],
  )

  // The route a slug's page is served at, shown under the slug: `buildPreviewSrc`'s route before
  // its prefix, base path, trailing slash and `?branch=`. Undefined when the entry has no page.
  const previewPathFor = (entry: {
    collectionPath: string
    collectionName?: string
    slug: string
    entryType?: string
  }): string | undefined => buildPreviewRoute(entry, { previewBaseByCollection, contentRoot })

  // Use collections from API (falls back to props if not loaded yet)
  const activeCollections = collectionsFromApi.length > 0 ? collectionsFromApi : collections

  // A preview error belongs to the entry that reported it.
  useEffect(() => {
    setPreviewError(null)
  }, [currentEntry?.contentId])

  // 3. Draft manager (depends on branchNameState, selectedPath from useEntryManager)
  const {
    drafts,
    setDrafts,
    loadedValues,
    setLoadedValues,
    loadedValue,
    effectiveValue,
    modifiedCount,
    editedFiles,
    handleSave,
    handleDiscardDrafts,
    handleDiscardFileDraft,
    handleReload,
    isSelectedDirty,
    resolveUnsaved,
    fieldErrors,
    draftStorageFailed,
    applySubmitStamps,
  } = useDraftManager({
    branchName: branchNameState,
    selectedPath,
    currentEntry,
    entries: entriesState,
    initialValues,
    loadEntry,
    readEntryValue,
    saveEntry,
    getEntryVersion,
    adoptEntryVersion,
    followMovedEntry,
    recreateEntry,
    setBusy: setEntriesLoading,
    // The errors are in the form.
    onSaveBlocked: () => setPreviewMaximized(false),
    onSaved: () => {
      void refreshEntries(branchNameState).catch((err) =>
        console.error('Failed to refresh entries after save', err),
      )
    },
    // An Undo built on a discarded draft would put back an item the server's copy already has.
    onDraftsReset: (contentId) => dismissUndoToasts(contentId),
  })
  resolveUnsavedRef.current = resolveUnsaved
  applySubmitStampsRef.current = applySubmitStamps

  // 4. Branch actions (depends on resolveUnsaved, setBranchName)
  const {
    handleBranchChange,
    confirmCreate: confirmCreateBranch,
    handleCreateBranch,
    confirmOpen: branchConfirmOpen,
  } = useBranchActions({
    branchName: branchNameState,
    setBranchName,
    getUnsaved: resolveUnsaved,
    onReloadBranches: () => loadBranches(),
    onBranchCreated: addCreatedBranch,
    userId: userContext?.userId,
  })

  // 5. Comment system (depends on branchNameState)
  const {
    comments,
    getCommentUser,
    focusedFieldPath,
    highlightThreadId,
    commentsPanelOpen,
    setCommentsPanelOpen,
    handleAddComment,
    handleResolveThread,
    handleJumpToField,
    handleJumpToEntry,
    handleJumpToBranch,
  } = useCommentSystem({
    branchName: branchNameState,
    selectedPath,
    currentEntry,
    currentUser: commentUserId,
    canResolveComments: canResolveAnyComment,
    setSelectedPath,
    setBranchManagerOpen: (open) => {
      if (open) branchOpenerRef.current = rememberOpener()
      setBranchManagerOpen(open)
    },
    onCommentsChange: setCommentsForBranchSummaries,
    onRevealForm: revealForm,
  })

  const {
    groupsData,
    groupsLoading,
    handleSaveGroups,
    handleSearchUsers,
    handleGetUserMetadata,
    handleSearchExternalGroups,
  } = useGroupManager({ isOpen: groupManagerOpen })
  // The comments and branches responses name their people, without email; a privileged lookup
  // adds the email.
  const getCommentUserMetadata = canResolveUserNames ? handleGetUserMetadata : getCommentUser

  const { permissionsData, permissionsLoading, handleSavePermissions, handleListGroups } =
    usePermissionManager({
      isOpen: permissionManagerOpen,
    })

  // 6. Schema manager (depends on branchNameState)
  const {
    createCollection,
    updateCollection,
    deleteCollection,
    addEntryType,
    updateEntryType,
    removeEntryType,
    updateOrder,
    deleteEntry,
    isLoading: schemaLoading,
  } = useSchemaManager({
    branchName: branchNameState,
    onSchemaChange: () => refreshEntries(branchNameState),
  })

  // Read-only content shows the saved value, never a draft; a restored draft is kept, unseen,
  // until it is discarded or the branch unlocks.
  const contentReadOnly = branchContentLocked || currentEntry?.canEdit === false
  const displayValue = contentReadOnly ? loadedValue : effectiveValue
  // Read when an edit lands, which an upload or other async field work can do renders later.
  const contentReadOnlyRef = useRef(contentReadOnly)
  contentReadOnlyRef.current = contentReadOnly

  // Undo for a form Remove: a toast whose Undo puts the item back into the entry's draft as it
  // is then, through a functional update, so edits made since are kept. It acts only on the
  // branch and entry it was raised for, and its toast closes when either changes.
  const loadedValuesRef = useRef(loadedValues)
  loadedValuesRef.current = loadedValues
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  // Open Undo toasts, by id, with the entry each belongs to.
  const undoToastsRef = useRef(new Map<string, string>())
  const nextUndoToastRef = useRef(0)
  const dismissUndoToasts = (contentId?: string) => {
    undoToastsRef.current.forEach((entry, id) => {
      if (contentId !== undefined && entry !== contentId) return
      notifications.hide(id)
      undoToastsRef.current.delete(id)
    })
  }
  const handleFieldRemoved = (removal: FieldRemoval) => {
    const contentId = currentEntry?.contentId
    if (!contentId || contentReadOnlyRef.current) return
    const branch = branchNameState
    const fields = schema
    // Taken from the value this render shows, which the removal has not reached yet.
    const anchored: FieldRemoval = {
      ...removal,
      anchors: displayValue ? removalAnchors(fields, displayValue, removal) : undefined,
    }
    const doing = removal.action === 'clear' ? 'clearing' : 'removing'
    // Open threads keyed inside what was removed leave their fields for the entry's thread list.
    const movedThreads = currentEntry
      ? openThreadsWithin(
          displayComments,
          currentEntry.path,
          removal.kind === 'list-item' ? [...removal.listPath, removal.index] : removal.path,
        )
      : 0
    nextUndoToastRef.current += 1
    const id = `canopy-undo-${nextUndoToastRef.current}`
    let used = false
    const undo = () => {
      // A closing toast stays clickable while it animates out: act once, and only while open.
      if (used) return
      used = true
      const open = undoToastsRef.current.has(id)
      notifications.hide(id)
      undoToastsRef.current.delete(id)
      if (!open) {
        notifications.show({
          message: `Too late to undo ${doing} ${removal.label}.`,
          color: 'yellow',
        })
        return
      }
      if (
        currentBranchRef.current !== branch ||
        currentContentIdRef.current !== contentId ||
        contentReadOnlyRef.current
      ) {
        return
      }
      const now = draftsRef.current[contentId] ?? loadedValuesRef.current[contentId]
      if (!now || !restoreRemoval(fields, now, anchored)) {
        notifications.show({
          message: `Couldn't undo ${doing} ${removal.label}: that part of the entry has changed. ${removal.action === 'clear' ? 'Fill it in again' : 'Add it again'} if you still need it.`,
          color: 'yellow',
        })
        return
      }
      const restoredPath = formatCanopyPath(restoredFieldPath(fields, now, removal))
      setDrafts((prev) => {
        const base = prev[contentId] ?? loadedValuesRef.current[contentId]
        const restored = base ? restoreRemoval(fields, base, anchored) : undefined
        return restored ? { ...prev, [contentId]: restored } : prev
      })
      // The toast's Undo button unmounts with it, so focus goes to the restored row once rendered.
      revealForm()
      requestAnimationFrame(() => {
        const target = findFieldTarget(restoredPath)
        if (target) focusFieldTarget(target.element)
      })
    }
    undoToastsRef.current.set(id, contentId)
    const toast = {
      id,
      message: (
        <UndoToastMessage
          label={removal.label}
          action={removal.action}
          note={
            movedThreads > 0
              ? `Its ${movedThreads === 1 ? 'comment thread' : `${movedThreads} comment threads`} moved to "Comment on this entry".`
              : undefined
          }
          onUndo={undo}
          onHold={() => notifications.update({ ...toast, autoClose: false })}
          onRelease={() => notifications.update(toast)}
        />
      ),
      autoClose: getNotificationDuration(8000),
      withCloseButton: true,
      onClose: () => undoToastsRef.current.delete(id),
    }
    notifications.show(toast)
  }
  useEffect(() => () => dismissUndoToasts(), [currentEntry?.contentId, branchNameState])
  // Only once the branch has answered, so the fail-closed lock while it loads raises no notice.
  const hiddenDraftNotice =
    contentReadOnly && currentBranch !== undefined && !!currentEntry && isSelectedDirty()

  const collectionLabels = useMemo(
    () => buildCollectionLabels(activeCollections),
    [activeCollections],
  )
  const schema = currentEntry?.schema ?? EMPTY_SCHEMA

  // Field threads follow their items' keys, placed in their entry's value where it is at hand.
  const entryValue = (entry: EditorEntry): FormValue | undefined => {
    if (entry.path === currentEntry?.path) return displayValue
    // As `displayValue` would show it: read-only content shows its saved value, not a draft.
    const readOnly = branchContentLocked || entry.canEdit === false
    return (readOnly ? undefined : drafts[entry.contentId]) ?? loadedValues[entry.contentId]
  }
  const displayComments = useMemo(() => {
    const byPath = new Map(entriesState.map((entry) => [entry.path as string, entry]))
    return comments.map((thread) => {
      const entry = thread.entryPath ? byPath.get(thread.entryPath) : undefined
      const value = entry ? entryValue(entry) : undefined
      if (thread.type !== 'field' || !thread.canopyPath || !thread.itemKeys?.length) return thread
      if (!entry || !value) return thread
      const path = resolveThreadPath(entry.schema, value, thread.canopyPath, thread.itemKeys)
      if (path === null) return { ...thread, onRemovedItem: true }
      return path === thread.canopyPath ? thread : { ...thread, canopyPath: path }
    })
    // `entryValue` reads the open entry, its shown value, and the drafts and loads.
  }, [
    comments,
    entriesState,
    currentEntry,
    displayValue,
    drafts,
    loadedValues,
    branchContentLocked,
  ])

  // A jump into another entry waits for its value to place the thread; the stored path may be stale.
  const [pendingFieldJump, setPendingFieldJump] = useState<{
    entryPath: string
    canopyPath: string
    threadId: string
  } | null>(null)
  const jumpToThreadField = (entryPath: string, canopyPath: string, threadId: string) => {
    if (entryPath === currentEntry?.path) {
      handleJumpToField(entryPath, canopyPath, threadId)
      return
    }
    setPendingFieldJump({ entryPath, canopyPath, threadId })
    setSelectedPath(entryPath)
  }
  useEffect(() => {
    if (!pendingFieldJump) return
    if (selectedPath !== pendingFieldJump.entryPath) {
      setPendingFieldJump(null)
      return
    }
    if (currentEntry?.path !== pendingFieldJump.entryPath || !displayValue) return
    const { entryPath, canopyPath, threadId } = pendingFieldJump
    setPendingFieldJump(null)
    const placed = displayComments.find((t) => t.id === threadId)
    // A thread whose item is gone lives on its entry, not at the index it was made at.
    if (placed?.onRemovedItem) handleJumpToEntry(entryPath, threadId)
    else handleJumpToField(entryPath, placed?.canopyPath ?? canopyPath, threadId)
  }, [pendingFieldJump, selectedPath, currentEntry, displayValue, displayComments])

  // A thread on an item only the draft has is refused: a discard would leave it on nothing.
  const handleAddDisplayedComment: typeof handleAddComment = async (
    text,
    type,
    entryPath,
    canopyPath,
    threadId,
  ) => {
    if (
      type !== 'field' ||
      threadId ||
      !canopyPath ||
      !currentEntry ||
      entryPath !== currentEntry.path ||
      !displayValue
    ) {
      return handleAddComment(text, type, entryPath, canopyPath, threadId)
    }
    const itemKeys = itemKeysOnPath(currentEntry.schema, displayValue, canopyPath)
    if (!itemKeys?.length) return handleAddComment(text, type, entryPath, canopyPath)
    // The field's control says so before anyone types (`commentBlockedReason`); this is the backstop.
    if (!loadedValue) throw new Error(ENTRY_NOT_LOADED_COMMENT_MESSAGE)
    if (onUnsavedItem(itemKeys, canopyPath)) throw new Error(NEW_ITEM_COMMENT_MESSAGE)
    return handleAddComment(text, type, entryPath, canopyPath, undefined, itemKeys)
  }
  const onUnsavedItem = (itemKeys: string[], canopyPath: string): boolean =>
    !currentEntry ||
    !loadedValue ||
    resolveThreadPath(currentEntry.schema, loadedValue, canopyPath, itemKeys) === null
  // Says nothing until the saved value is known, which is what tells a new item from a saved one.
  const commentBlockedReason = (canopyPath: string): string | undefined => {
    if (!currentEntry || !displayValue || !loadedValue) return undefined
    const itemKeys = itemKeysOnPath(currentEntry.schema, displayValue, canopyPath)
    return itemKeys?.length && onUnsavedItem(itemKeys, canopyPath)
      ? NEW_ITEM_COMMENT_MESSAGE
      : undefined
  }

  const commentEntryLabel = (entryPath: string) =>
    entriesState.find((e) => e.path === entryPath)?.label
  // Only the open entry's value is at hand; for another entry the breadcrumb falls back to its
  // schema's field labels.
  // Items are named only where a value placed the thread; otherwise its indexes may be stale.
  const commentFieldLabel = (thread: CommentThread) => {
    const entry = entriesState.find((e) => e.path === thread.entryPath)
    if (!entry || !thread.canopyPath) return undefined
    const value = entryValue(entry)
    // While a removal is only in the draft, the saved value still holds the item to name.
    const saved = thread.onRemovedItem ? loadedValues[entry.contentId] : undefined
    const savedPath = saved
      ? resolveThreadPath(entry.schema, saved, thread.canopyPath, thread.itemKeys)
      : null
    if (saved && savedPath !== null) {
      return fieldBreadcrumb(entry.schema, saved, savedPath).join(' › ')
    }
    const placed = !!value && !thread.onRemovedItem
    const items = placed || !thread.itemKeys?.length
    return fieldBreadcrumb(entry.schema, placed ? value : undefined, thread.canopyPath, {
      items,
    }).join(' › ')
  }

  // Gated on `loadedValues[contentId]` (not `drafts[contentId]`) so a
  // restored-from-localStorage draft never skips the load: skipping left
  // `loadedValues[contentId]` permanently undefined, which made dirty-
  // tracking meaningless (a draft with no loaded value counts as dirty
  // everywhere in useDraftManager) and silently starved the entry of a
  // fresh server read. The draft is still preserved as an overlay below —
  // only the "did we ever fetch the server value" gate changed.
  //
  // In-flight loads, keyed `${branch}:${contentId}` -- NOT the bare contentId.
  // The same contentId exists on every branch (branches are clones and IDs are
  // embedded in filenames), so a bare-id key made the PREVIOUS branch's pending
  // load dedupe away the NEW branch's load entirely: the new branch's read was
  // never issued, and the old response then settled into the shared state under
  // that same id. Qualifying the key lets both loads coexist; the branch check
  // at settle time decides which one is allowed to write.
  const loadingEntryIdsRef = useRef<Set<string>>(new Set())
  // The entry (keyed like `loadingEntryIdsRef`) whose last read failed, and Retry's bump that
  // runs the load effect below again.
  const [loadFailedKey, setLoadFailedKey] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  // Reset during render, not in an effect, so returning to a failed entry never paints its Alert
  // for the frame before its load starts again.
  const selectionKey = `${branchNameState}:${currentEntry?.contentId ?? ''}`
  const [loadFailedSelection, setLoadFailedSelection] = useState(selectionKey)
  if (loadFailedSelection !== selectionKey) {
    setLoadFailedSelection(selectionKey)
    setLoadFailedKey(null)
  }
  // Entries (keyed like `loadingEntryIdsRef`) whose read the API refused as SCHEMA_UNAVAILABLE.
  // The ref stops the load effect retrying them; the state re-renders the notice.
  const schemaUnavailableRef = useRef<Set<string>>(new Set())
  const [schemaUnavailableKeys, setSchemaUnavailableKeys] = useState<ReadonlySet<string>>(new Set())
  // A refetch of entries or schema is the signal the server's schema may have changed, so every
  // refusal is forgotten and the next open of each entry reads it once more. Declared before the
  // load effect so a refetch's retry sees the cleared set in the same commit.
  useEffect(() => {
    if (schemaUnavailableRef.current.size === 0) return
    schemaUnavailableRef.current = new Set()
    setSchemaUnavailableKeys(new Set())
  }, [entriesState, collectionsFromApi])
  // A successful read (File > Reload) of a refused entry ends the refusal.
  useEffect(() => {
    if (schemaUnavailableRef.current.size === 0) return
    const stale = [...schemaUnavailableRef.current].filter((key) => {
      const [keyBranch, ...id] = key.split(':')
      return keyBranch === branchNameState && loadedValues[id.join(':')] !== undefined
    })
    if (stale.length === 0) return
    stale.forEach((key) => schemaUnavailableRef.current.delete(key))
    setSchemaUnavailableKeys(new Set(schemaUnavailableRef.current))
  }, [loadedValues, branchNameState])
  // The contentId this effect is CURRENTLY targeting, kept in sync every
  // render (not in an effect -- it must be current by the time an in-flight
  // load's `finally`/`catch` runs, which can be after several re-renders).
  // Lets a load whose entry the user has since navigated away from tell
  // it's stale when it settles, so it doesn't clear the shared loading flag
  // out from under a NEWER load that's still in flight, and doesn't surface
  // a "Failed to load entry" notification for content nobody is looking at
  // anymore.
  const currentContentIdRef = useRef<ContentId | undefined>(currentEntry?.contentId)
  currentContentIdRef.current = currentEntry?.contentId
  // Same idea for the branch, and for the same reason useEntryManager keeps its
  // own `currentBranchRef`: an async settle runs several renders later, so the
  // branch captured in its closure is exactly the value that goes stale when
  // the user switches mid-flight -- which is the only moment the check matters.
  const currentBranchRef = useRef(branchNameState)
  currentBranchRef.current = branchNameState

  useEffect(() => {
    const contentId = currentEntry?.contentId
    // Pin the branch this load targets. `loadEntry` pins the same value
    // internally (that is the branch its OCC token gets recorded under), so
    // comparing against it at settle time answers "is the state I'm about to
    // write still the state of the branch on screen?".
    const requestBranch = branchNameState
    const inFlightKey = `${requestBranch}:${contentId ?? ''}`
    const load = async () => {
      if (!currentEntry || !contentId || loadedValues[contentId] !== undefined) return
      // An unavailable type has no schema to read it against; the server would refuse the read.
      if (currentEntry.unavailable || schemaUnavailableRef.current.has(inFlightKey)) return
      // Guard against overlapping renders re-firing the same in-flight load
      // (e.g. `currentEntry` getting a new object reference from an entries
      // refresh while the fetch below is still pending).
      if (loadingEntryIdsRef.current.has(inFlightKey)) return
      loadingEntryIdsRef.current.add(inFlightKey)
      setEntriesLoading(true)
      setLoadFailedKey((failed) => (failed === inFlightKey ? null : failed))
      try {
        const loaded = await loadEntry(currentEntry)
        // A branch switch during the await makes this response another
        // branch's content. Writing it would (a) show it as the new branch's
        // content and (b) satisfy the skip gate above, permanently suppressing
        // the new branch's own load -- which also leaves the new branch's OCC
        // token unset, so saveEntry refuses every save of the entry. Drop it
        // instead; the new branch has its own load running under its own key.
        if (currentBranchRef.current !== requestBranch) return
        setLoadedValues((prev) => ({ ...prev, [contentId]: loaded }))
        // No draft is seeded here. `effectiveValue` is
        // `drafts[id] ?? loadedValues[id]`, so the form renders from the line
        // above alone; seeding `drafts[id] = loaded` only manufactured a
        // pristine draft for every entry the user merely OPENED, which
        // useDraftManager then persisted to localStorage -- restored next
        // session as a dirty, stale full-content snapshot.
      } finally {
        loadingEntryIdsRef.current.delete(inFlightKey)
        // Clear the shared flag if this load's entry is still selected on the
        // branch it was loaded for, OR if no other load remains in flight. The
        // second arm matters when the user navigates from a slow-loading entry
        // to one that's ALREADY loaded: no new load starts, so "a newer
        // selection's own load owns the flag now" doesn't hold -- without it,
        // this stale settle would leave `entriesLoading` (and therefore
        // `busy`) stuck true with nothing left to clear it.
        if (
          (currentBranchRef.current === requestBranch &&
            currentContentIdRef.current === contentId) ||
          loadingEntryIdsRef.current.size === 0
        ) {
          setEntriesLoading(false)
        }
      }
    }
    load().catch((err) => {
      if (err instanceof EntrySchemaUnavailableError) {
        schemaUnavailableRef.current.add(inFlightKey)
        setSchemaUnavailableKeys((prev) => new Set(prev).add(inFlightKey))
        return
      }
      console.error(err)
      // Same staleness guard as above: don't tell the user an entry failed
      // to load when they've already navigated to a different one (or to a
      // different branch).
      if (currentBranchRef.current === requestBranch && currentContentIdRef.current === contentId) {
        notifications.show({ message: 'Failed to load entry', color: 'red' })
        setLoadFailedKey(inFlightKey)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable setters, run only on entry/path/branch/loadedValues change
  }, [currentEntry, loadedValues, selectedPath, branchNameState, loadAttempt])

  // The collection dialog's entry types, with schema and usage, as the branch has them; null when
  // the API refuses the read or the collection is gone, and a rejection when the read times out.
  const readEntryTypes = async (
    collectionPath: LogicalPath,
  ): Promise<ExistingEntryType[] | null> => {
    const result = await apiClient.schema.getCollection({
      branch: branchNameState,
      collectionPath,
    })
    const withUsage = result.ok ? result.data?.entryTypesWithUsage : undefined
    return withUsage
      ? withUsage.map(
          (et): ExistingEntryType => ({
            name: et.name,
            label: et.label,
            format: et.format,
            schema: et.schemaRef,
            default: et.default,
            maxItems: et.maxItems,
            usageCount: et.usageCount,
          }),
        )
      : null
  }

  const handleOpenCollectionEditor = async (
    collection: EditorCollection | null,
    parentPath?: LogicalPath,
  ) => {
    const opening = ++collectionOpeningRef.current
    const branch = branchNameState
    const stillCurrent = () =>
      opening === collectionOpeningRef.current && currentBranchRef.current === branch
    // A draft is checked on a fresh tree first: refilling a create that landed would duplicate it.
    const draft = collectionDraftRef.current
    // A details save that changed the slug and landed is reopened at its new path, never refilled.
    const atNewPath =
      draft?.kind === 'details' &&
      !!draft.updates.slug &&
      collection?.path ===
        `${draft.collectionPath.slice(0, draft.collectionPath.lastIndexOf('/') + 1)}${draft.updates.slug}`
    const refills =
      draft?.branch === branch &&
      (draft.kind === 'create'
        ? !collection && draft.input.parentPath === parentPath
        : collection?.path === draft.collectionPath || atNewPath)
    let restore: RestoredCollectionInput | null = null
    if (draft && refills) {
      const fresh = await refreshContent(branch).catch((err: unknown) => {
        console.error(err)
        return null
      })
      if (!stillCurrent()) return
      if (fresh && collectionDraftLanded(fresh.collections, draft)) {
        settleCollectionDraft(draft)
      } else if (
        collectionDraftRef.current === draft &&
        !atNewPath &&
        (fresh || draft.kind === 'details')
      ) {
        // A create no read has ruled out stays unfilled; a details save resends the same change.
        restore = draft.kind === 'create' ? draft.input : draft.updates
      }
    }
    if (collection) {
      // The tree's entry types, the fallback, carry no schema or usage.
      const read = await readEntryTypes(collection.path).catch(() => null)
      if (!stillCurrent()) return
      const entries =
        read ??
        (collection.entryTypes ?? []).map(
          (et): ExistingEntryType => ({
            name: et.name,
            label: et.label,
            format: et.format,
            schema: '',
            default: et.default,
            maxItems: et.maxItems,
          }),
        )
      setEditingCollection({
        name: collection.name,
        label: collection.label,
        logicalPath: collection.path,
        entries,
      })
      setCollectionEditorParentPath(undefined)
    } else {
      setEditingCollection(null)
      setCollectionEditorParentPath(parentPath)
    }
    refilledDraftRef.current = restore ? draft : null
    setRestoredCollectionInput(restore)
    setCollectionEditorError(null)
    setCollectionEditorOpen(true)
  }

  const handleCloseCollectionEditor = () => {
    collectionOpeningRef.current++
    setCollectionEditorOpen(false)
    setEditingCollection(null)
    setCollectionEditorParentPath(undefined)
    setCollectionEditorError(null)
  }

  const handleCollectionSave = async (
    data: Parameters<typeof createCollection>[0] | Parameters<typeof updateCollection>[1],
    isNew: boolean,
  ) => {
    setCollectionEditorError(null)
    // createCollection/updateCollection are contractually non-throwing (they
    // return result objects — see useSchemaManager), so branch on `result.ok`
    // instead of try/catch.
    const draft = collectionDraftRef.current
    if (isNew) {
      const input = data as Parameters<typeof createCollection>[0]
      const result = await createCollection(input)
      // A retried create that had landed makes a second collection, so an unanswered one closes
      // the dialog too, leaving the hook's toast to say to check the "Content" panel first.
      if (result.ok || result.unanswered) {
        if (!result.ok) {
          collectionDraftRef.current = { branch: branchNameState, kind: 'create', input }
        } else if (
          collectionDraftRef.current === draft &&
          draft?.kind === 'create' &&
          draft.branch === branchNameState &&
          draft.input.parentPath === input.parentPath &&
          (draft === refilledDraftRef.current || draft.input.name === input.name)
        ) {
          collectionDraftRef.current = null
        }
        handleCloseCollectionEditor()
      } else {
        setCollectionEditorError(result.error)
      }
    } else if (editingCollection) {
      const updates = data as Parameters<typeof updateCollection>[1]
      const collectionPath = editingCollection.logicalPath
      const result = await updateCollection(collectionPath, updates)
      // An unanswered save may have renamed the collection, leaving `editingCollection`'s path
      // stale, so the dialog closes; the hook's toast says to reopen it and check.
      if (result.ok || result.unanswered) {
        // An update with no defined value sent nothing worth filling in again.
        const sent = Object.values(updates).some((value) => value !== undefined)
        if (!result.ok && sent) {
          collectionDraftRef.current = {
            branch: branchNameState,
            kind: 'details',
            collectionPath,
            updates,
          }
        } else if (
          result.ok &&
          collectionDraftRef.current === draft &&
          draft?.kind === 'details' &&
          draft.branch === branchNameState &&
          draft.collectionPath === collectionPath
        ) {
          collectionDraftRef.current = null
        }
        handleCloseCollectionEditor()
      } else {
        setCollectionEditorError(result.error)
      }
    }
  }

  /** The draft's write landed: drop it, take its warning down and say so, once. */
  const settleCollectionDraft = (draft: CollectionDraft) => {
    if (collectionDraftRef.current !== draft) return
    collectionDraftRef.current = null
    setRestoredCollectionInput(null)
    hideCollectionOutcomeUnknown()
    notifications.show({
      message:
        draft.kind === 'create' ? `Collection "${draft.input.name}" created` : 'Collection updated',
      color: 'green',
    })
  }

  const handleDeleteCollection = (collectionPath: LogicalPath) => {
    setDeletingCollectionPath(collectionPath)
    setDeleteCollectionModalOpen(true)
  }

  const confirmDeleteCollection = async () => {
    if (!deletingCollectionPath) return
    setDeleteInProgress(true)
    try {
      await deleteCollection(deletingCollectionPath)
      setDeleteCollectionModalOpen(false)
      setDeletingCollectionPath(null)
    } finally {
      setDeleteInProgress(false)
    }
  }

  const handleDeleteEntry = (entryPath: LogicalPath) => {
    setDeletingEntryPath(entryPath)
    setDeletingEntryReferencedBy(null)
    setDeleteEntryModalOpen(true)
  }

  const closeDeleteEntryModal = () => {
    setDeleteEntryModalOpen(false)
    setDeletingEntryPath(null)
    setDeletingEntryReferencedBy(null)
  }

  const confirmDeleteEntry = async () => {
    if (!deletingEntryPath) return
    setDeleteInProgress(true)
    try {
      // The user has seen the referencing entries only once the server has named them.
      const result = await deleteEntry(deletingEntryPath, {
        confirmReferenced: deletingEntryReferencedBy !== null,
      })
      if (!result.ok && 'referencedBy' in result) {
        setDeletingEntryReferencedBy(result.referencedBy)
        return
      }
      if (result.ok && selectedPath === deletingEntryPath) {
        setSelectedPath('')
      }
      closeDeleteEntryModal()
    } finally {
      setDeleteInProgress(false)
    }
  }

  const handleRenameEntry = (entryPath: string) => {
    // Find the entry being renamed
    const entry = entriesState.find((e) => e.path === entryPath)
    if (!entry) {
      notifications.show({ message: 'Entry not found', color: 'red' })
      return
    }
    setRenamingEntry(entry)
    setRenameModalError(null)
    setRenameModalOpen(true)
  }

  const handleRenameSubmit = async (newSlug: string) => {
    if (!renamingEntry) return
    setRenameModalSaving(true)
    setRenameModalError(null)
    try {
      await renameEntry(renamingEntry.path, newSlug)
      setRenameModalOpen(false)
      setRenamingEntry(null)
    } catch (err) {
      setRenameModalError({
        message: err instanceof Error ? err.message : 'Rename failed',
        mayHaveLanded: err instanceof MayHaveLandedError,
      })
    } finally {
      setRenameModalSaving(false)
    }
  }

  const handleReorderEntry = async (
    collectionPath: LogicalPath,
    contentId: string,
    direction: 'up' | 'down',
  ) => {
    const findCollection = (
      cols: EditorCollection[] | undefined,
      path: string,
    ): EditorCollection | undefined => {
      if (!cols) return undefined
      for (const col of cols) {
        if (col.path === path) return col
        const found = findCollection(col.children, path)
        if (found) return found
      }
      return undefined
    }
    // Resolve against `collectionsFromApi`, NOT `activeCollections`: the latter
    // falls back to the build-time `collections` prop whenever the fetch is
    // still empty -- exactly the state mid-branch-switch. A write resolved
    // against that fallback would silently PATCH the OLD branch's `order` onto
    // the NEW branch instead of hitting the not-found guard below; reading
    // `collectionsFromApi` directly makes "not yet loaded" and "loaded, no such
    // collection" the same not-found outcome.
    const collection = findCollection(collectionsFromApi, collectionPath)
    if (!collection) {
      // A silent no-op on a clicked menu item reads as a broken button --
      // tell the user why nothing happened instead of leaving them to
      // wonder. This fires legitimately during the ordinary branch-switch
      // window (data not there YET), not only on a genuine error, so it's a
      // transient "try again" notice rather than an error-red one.
      notifications.show({
        message: 'Content is still loading for this branch — try again in a moment.',
        color: 'yellow',
      })
      return
    }

    let currentOrder: string[]
    if (collection.order && collection.order.length > 0) {
      currentOrder = [...collection.order]
    } else {
      const collectionEntries = entriesState.filter((e) => e.collectionPath === collectionPath)
      const entryIds = collectionEntries
        .map((e) => e.contentId)
        .filter((id): id is ContentId => !!id)
      const subCollectionIds = (collection.children ?? [])
        .map((child) => child.contentId)
        .filter((id): id is ContentId => !!id)
      currentOrder = [...entryIds, ...subCollectionIds]
    }

    const currentIndex = currentOrder.indexOf(contentId)
    if (currentIndex === -1) return

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (newIndex < 0 || newIndex >= currentOrder.length) return

    const newOrder = [...currentOrder]
    ;[newOrder[currentIndex], newOrder[newIndex]] = [newOrder[newIndex], newOrder[currentIndex]]

    await updateOrder(collectionPath, newOrder)
  }

  // The entry's type has no schema here, or the API refused its read as unavailable. Its
  // form is replaced by a notice, so nothing about it can be saved.
  const isEntryUnavailable = (entry: EditorEntry): boolean =>
    !!entry.unavailable || schemaUnavailableKeys.has(`${branchNameState}:${entry.contentId}`)
  const currentEntryUnavailable = !!currentEntry && isEntryUnavailable(currentEntry)

  // Determine if we should hide the root collection (but keep its context for ordering)
  const hiddenRootPath = useMemo(() => {
    if (activeCollections?.length === 1 && activeCollections[0].path === contentRoot) {
      return contentRoot
    }
    return undefined
  }, [activeCollections, contentRoot])

  const navCollections = useMemo<EntryNavCollection[] | undefined>(() => {
    if (!activeCollections) return undefined

    const grouped = new Map<string, EntryNavCollection['entries']>()
    entriesState.forEach((entry) => {
      if (!entry.collectionPath) return
      const list = grouped.get(entry.collectionPath) ?? []
      list.push({
        path: entry.path,
        label: entry.label,
        slug: entry.slug,
        status: entryStatusLabel(activeCollections, entry),
        contentId: entry.contentId,
        readOnly: entry.canEdit === false || undefined,
        conflictNotice: !!(
          entry.contentId && currentBranch?.conflictFiles?.includes(entry.contentId)
        ),
        unavailable: isEntryUnavailable(entry) || undefined,
      })
      grouped.set(entry.collectionPath, list)
    })

    const build = (node: EditorCollection): EntryNavCollection => {
      const entries = grouped.get(node.path) ?? []
      const children = node.children?.map((child) => build(child)) ?? []
      const unavailableRefs = unavailableSchemaRefs(node.entryTypes)
      // No entry can be created where every entry type is unavailable.
      const allUnavailable =
        !!node.entryTypes?.length && node.entryTypes.every((et) => et.unavailable)
      // A collection that holds only collections has no entry type to add (`entryTypes` is
      // undefined when its list is empty).
      const addable = node.type !== 'entry' && !allUnavailable && (node.entryTypes?.length ?? 0) > 0
      const canAddEntry = addable && node.canAddEntry !== false

      return {
        path: node.path,
        label: node.label ?? node.name,
        type: node.type,
        contentId: node.contentId,
        order: node.order,
        entries: entries.length > 0 ? entries : undefined,
        children: children.length > 0 ? children : undefined,
        conflictNotice: !!(
          node.contentId && currentBranch?.conflictFiles?.includes(node.contentId)
        ),
        unavailableSchemaRefs: unavailableRefs.length > 0 ? unavailableRefs : undefined,
        addRefused: (addable && node.canAddEntry === false) || undefined,
        onAdd: canAddEntry
          ? () => (onCreateEntry ? onCreateEntry(node.path) : handleCreateEntry(node.path))
          : undefined,
        onEdit:
          userIsAdmin && node.type === 'collection'
            ? () => handleOpenCollectionEditor(node)
            : undefined,
        onAddSubCollection:
          userIsAdmin && node.type === 'collection'
            ? () => handleOpenCollectionEditor(null, node.path)
            : undefined,
        onDelete:
          userIsAdmin && node.type === 'collection'
            ? () => handleDeleteCollection(node.path)
            : undefined,
      }
    }
    return activeCollections.map((node) => build(node))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler refs are stable, rebuild only on data changes
  }, [
    activeCollections,
    entriesState,
    onCreateEntry,
    handleCreateEntry,
    contentRoot,
    currentBranch,
    schemaUnavailableKeys,
    userIsAdmin,
  ])

  const quickOpenShortcut = modKeyLabel() === '⌘' ? '⌘P' : 'Ctrl+P'
  const quickOpenKeys = modKeyLabel() === '⌘' ? 'Meta+P' : 'Control+P'
  // Docked, the content panel's open state is the stored preference; as an overlay it is
  // `navigatorOpen`, which starts open when the URL asks for no entry.
  const contentPanelShown = contentPanelDocked ? contentPanelOpen : navigatorOpen
  const setContentPanelShown = (open: boolean) =>
    contentPanelDocked ? setContentPanelOpen(open) : setNavigatorOpen(open)
  // The overlay lives in the form pane, under a maximized preview.
  const contentOverlayShown = !contentPanelDocked && contentPanelShown
  useEffect(() => {
    if (contentOverlayShown) setPreviewMaximized(false)
  }, [contentOverlayShown])
  // Bumped on every ask for the panel, so one already open still takes focus.
  const [contentPanelFocusRequest, setContentPanelFocusRequest] = useState(0)
  const openNavigator = () => {
    navigatorOpenerRef.current = rememberOpener()
    // In the same commit as the overlay mounts, so its focus request meets no inert form panel.
    if (!contentPanelDocked) setPreviewMaximized(false)
    setContentPanelShown(true)
    setContentPanelFocusRequest((request) => request + 1)
  }
  const navigatorReturnTarget = () =>
    returnTarget(navigatorOpenerRef.current, () => navigatorToggleRef.current)
  const branchReturnTarget = () =>
    returnTarget(branchOpenerRef.current, () => branchToggleRef.current)
  const settingsReturnTarget = () => settingsToggleRef.current
  // The palette replaces the overlay panel; a docked one stays.
  const openQuickOpen = () => {
    if (!quickOpenOpen) setQuickOpenFromOverlay(!contentPanelDocked && navigatorOpen)
    if (!contentPanelDocked) setNavigatorOpen(false)
    setQuickOpenOpen(true)
  }

  const dirtyPaths = useMemo<ReadonlySet<string>>(
    () => new Set(editedFiles.map((file) => file.path)),
    [editedFiles],
  )

  // Slugs of the entries beside the one being renamed, for the duplicate check.
  const renameExistingSlugs = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        entriesState
          .filter((e) => e.collectionPath === renamingEntry?.collectionPath && e.slug)
          .map((e) => e.slug as string),
      ),
    [entriesState, renamingEntry],
  )

  // Tree expansion state - persists across panel close/open
  const treeExpandedStateRef = useRef<Record<string, boolean>>({})

  const treeControllerRef = useRef<TreeController | null>(null)

  const handleTreeControllerReady = (controller: TreeController) => {
    treeControllerRef.current = controller
  }

  const handleExpandedStateChange = (state: Record<string, boolean>) => {
    treeExpandedStateRef.current = state
  }

  const handleCollapseAll = () => {
    treeControllerRef.current?.collapseAllNodes()
    treeExpandedStateRef.current = {}
  }

  const handleExpandAll = () => {
    treeControllerRef.current?.expandAllNodes()
    treeExpandedStateRef.current = treeControllerRef.current?.expandedState ?? {}
  }

  const { resolveEntryLinks } = useEntryLinkResolution({
    entries: entriesState,
    contentRoot,
    entryLinkUrl,
  })

  // Resolved here, outside the form and its per-field crash boundaries, and during render, so
  // the preview never receives a bare reference id: a reference is its target or `null`.
  const { resolvedValue: previewValue, loadingState: previewLoadingState } = useReferenceResolution(
    {
      value: displayValue ?? EMPTY_VALUE,
      fields: schema,
      branch: branchNameState,
      entryKey: currentEntry?.contentId,
    },
  )

  const previewFrameData = useMemo(
    () => (displayValue ? resolveEntryLinks(previewValue) : displayValue),
    [previewValue, displayValue, resolveEntryLinks],
  )

  // Entry link context for the InsertEntryLink toolbar button
  const entryLinkContextValue = useMemo(
    () => ({
      entries: entriesState.map(
        (e): EntryLinkOption => ({
          contentId: e.contentId,
          label: e.label,
          slug: e.slug,
          collectionPath: e.collectionPath,
          collectionName: e.collectionName,
        }),
      ),
    }),
    [entriesState],
  )

  const CenteredMessage = ({ children }: { children: React.ReactNode }) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
      }}
    >
      <Text size="sm" c="dimmed">
        {children}
      </Text>
    </div>
  )

  const {
    onMarks: onPreviewMarks,
    clearMarks: clearPreviewMarks,
    marksNothing: previewMarksNothing,
    inexactMarks: previewInexactMarks,
  } = usePreviewMarks({
    src: currentEntry?.previewSrc,
    highlightEnabled,
    fields: schema,
    data: displayValue,
  })

  // Only the default preview has the toolbar that maximizes and restores it. With no value to
  // preview (an entry loading, or failed to load, with no draft) the form shows instead, and the
  // choice reapplies once a value arrives.
  const previewCanMaximize =
    !renderPreview && Boolean(currentEntry?.previewSrc) && !currentEntryUnavailable
  const previewShownMaximized = previewMaximized && previewCanMaximize && Boolean(previewFrameData)
  useEffect(() => {
    if (!previewCanMaximize) setPreviewMaximized(false)
  }, [previewCanMaximize])
  const [paneResizing, setPaneResizing] = useState(false)

  const previewErrorField = previewError?.fieldPath
    ? fieldBreadcrumb(schema, displayValue, previewError.fieldPath).join(' › ')
    : ''

  // An unavailable entry previews nothing: the site cannot read it, and a stored draft would
  // otherwise mount the frame at a page that answers not-found.
  const defaultPreview =
    currentEntry?.previewSrc && previewFrameData && !currentEntryUnavailable ? (
      <PreviewPane
        src={currentEntry.previewSrc}
        data={previewFrameData}
        isLoading={previewLoadingState}
        highlightEnabled={highlightEnabled}
        onPreviewError={setPreviewError}
        onMarks={onPreviewMarks}
        assetBase={authenticatedAssetBase(basePath)}
        mount={{ basePath, previewPrefix }}
        previewWidth={previewWidth}
        onPreviewWidthChange={setPreviewWidth}
        onHighlightToggle={() => {
          setHighlightEnabled(!highlightEnabled)
          clearPreviewMarks()
        }}
        marksNothing={previewMarksNothing}
        inexactMarks={previewInexactMarks}
        showMarkDiagnostics={userIsAdmin}
        layout={layout}
        onLayoutChange={setLayout}
        maximized={previewShownMaximized}
        onMaximizedChange={setPreviewMaximized}
        resizing={paneResizing}
        notice={
          previewError && (
            <Alert
              color="red"
              title="Preview error"
              withCloseButton
              onClose={() => setPreviewError(null)}
              radius={0}
            >
              {previewErrorField
                ? `${previewErrorField}: ${previewError.message}`
                : previewError.message}
            </Alert>
          )
        }
      />
    ) : (
      <Paper
        withBorder
        shadow="xs"
        h="100%"
        bg="var(--mantine-color-body)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text size="sm" c="dimmed">
          {!branchNameState && busy
            ? 'Setting up your branch workspace…'
            : entriesInitializing
              ? 'Loading content…'
              : currentEntry && !currentEntry.previewSrc
                ? 'No preview for this entry.'
                : 'Select an item to start editing.'}
        </Text>
      </Paper>
    )

  const headerTitle = currentEntry?.label ?? currentEntry?.slug ?? title
  const breadcrumbSegments = useMemo(
    () => buildBreadcrumbSegments(currentEntry, collectionLabels),
    [collectionLabels, currentEntry],
  )

  const openBranchManager = () => {
    branchOpenerRef.current = rememberOpener()
    setBranchManagerOpen(true)
    // Always retry, not only when branchless. Opening the manager is
    // the one in-app retry for a failed branches fetch, and the fetch
    // is terminal on its own: SWRProvider sets shouldRetryOnError and
    // revalidateOnFocus false, and useBranchesData's refreshInterval
    // is 0 without data. Reloading is idempotent.
    loadBranches().catch(console.error)
  }

  const contentPanel = (
    <SidePanelHost
      id={CONTENT_PANEL_ID}
      title="Content"
      mode={contentPanelDocked ? 'docked' : 'overlay'}
      opened={contentPanelShown}
      width={contentPanelWidth}
      minWidth={CONTENT_PANEL_WIDTH_MIN}
      maxWidth={CONTENT_PANEL_WIDTH_MAX}
      onWidthChange={setContentPanelWidth}
      onClose={() => setContentPanelShown(false)}
      focusRequest={contentPanelFocusRequest}
      // Quick open takes focus as it replaces the overlay.
      returnFocusTo={() => (quickOpenOpen ? null : navigatorReturnTarget())}
      data-testid="content-panel"
      actions={
        <>
          {navCollections &&
            navCollections.length > 0 &&
            !branchContentLocked &&
            (navCollections[0].onAdd || navCollections[0].onAddSubCollection) && (
              <Menu shadow="md" width={200} withinPortal position="bottom-end">
                <Tooltip label="Content actions" withinPortal>
                  <Menu.Target>
                    <ActionIcon variant="subtle" color="gray" aria-label="Content actions">
                      <IconDots size={16} />
                    </ActionIcon>
                  </Menu.Target>
                </Tooltip>
                <Menu.Dropdown>
                  {navCollections[0].onAdd && (
                    <Menu.Item
                      leftSection={<IconPlus size={14} />}
                      onClick={() => navCollections[0].onAdd?.()}
                    >
                      Add entry…
                    </Menu.Item>
                  )}
                  {navCollections[0].onAddSubCollection && (
                    <>
                      {navCollections[0].onAdd && <Menu.Divider />}
                      <Menu.Label>Admin</Menu.Label>
                      <Menu.Item
                        leftSection={<IconFolderPlus size={14} />}
                        onClick={() => navCollections[0].onAddSubCollection?.()}
                      >
                        Add collection…
                      </Menu.Item>
                    </>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          <Tooltip label={`${EDITOR_ACTIONS.openEntry} (${quickOpenShortcut})`} withinPortal>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={openQuickOpen}
              aria-label={EDITOR_ACTIONS.openEntry}
              aria-keyshortcuts={quickOpenKeys}
              data-testid="quick-open-button"
            >
              <IconSearch size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Collapse all folders" withinPortal>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={handleCollapseAll}
              aria-label="Collapse all folders"
            >
              <IconChevronUp size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Expand all folders" withinPortal>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={handleExpandAll}
              aria-label="Expand all folders"
            >
              <IconChevronDown size={16} />
            </ActionIcon>
          </Tooltip>
        </>
      }
    >
      <Box px="md">
        <EntryNavigator
          collections={navCollections}
          items={
            navCollections
              ? undefined
              : entriesState.map((e) => ({
                  path: e.path,
                  label: e.label,
                  slug: e.slug,
                  status: entryStatusLabel(activeCollections, e),
                  readOnly: e.canEdit === false || undefined,
                }))
          }
          selectedPath={selectedPath}
          onSelect={openEntry}
          onTreeControllerReady={handleTreeControllerReady}
          expandedStateRef={treeExpandedStateRef}
          onExpandedStateChange={handleExpandedStateChange}
          onDeleteEntry={handleDeleteEntry}
          onRenameEntry={handleRenameEntry}
          onReorderEntry={userIsAdmin ? handleReorderEntry : undefined}
          hiddenRootPath={hiddenRootPath}
          loading={entriesInitializing}
          readOnly={branchContentLocked}
          dirtyPaths={dirtyPaths}
        />
      </Box>
    </SidePanelHost>
  )

  return (
    <CanopyCMSProvider {...(themeOptions ?? {})}>
      <AssetContextProvider basePath={basePath}>
        <EditorShell
          topBar={
            <EditorHeader
              siteTitle={siteTitle}
              siteSubtitle={siteSubtitle}
              headerTitle={headerTitle}
              currentEntry={currentEntry}
              branchName={branchNameState}
              operatingMode={operatingMode}
              branchStatus={currentBranch?.status}
              busy={busy}
              breadcrumbSegments={breadcrumbSegments}
              editedFiles={editedFiles}
              modifiedCount={modifiedCount}
              // A draft kept for an unavailable entry stays in storage but cannot be saved.
              hasUnsavedChanges={!currentEntryUnavailable && !contentReadOnly && isSelectedDirty()}
              draftStorageFailed={draftStorageFailed}
              userContext={userContext}
              branchCreatedBy={currentBranch?.createdBy}
              branchAccess={currentBranch?.access}
              // Fail-closed for the same reason branchContentLocked above is:
              // isProtected/writeBlocked gate real actions in EditorHeader (hiding
              // Submit, disabling Save), so a missing wire value must read as
              // "protected"/"blocked", not "unprotected"/"unblocked".
              // branchWriteBlocked reuses branchContentLocked itself rather than
              // re-deriving `?? true` a second time here, so there is exactly one
              // fail-closed computation of "are writes blocked" in this component.
              branchIsProtected={currentBranch?.isProtected ?? true}
              branchReadOnly={currentBranch?.readOnly}
              branchWriteBlocked={branchContentLocked}
              onNavigatorOpen={openNavigator}
              navigatorToggleRef={navigatorToggleRef}
              branchToggleRef={branchToggleRef}
              onFileReload={() => handleReload(() => navigatorToggleRef.current)}
              onFileDiscardDraft={() => handleDiscardFileDraft(() => navigatorToggleRef.current)}
              onEntrySelect={openEntry}
              onBranchReloadData={handleReloadBranchData}
              onBranchDiscardDrafts={() => handleDiscardDrafts(() => branchToggleRef.current)}
              onBranchManagerOpen={openBranchManager}
              onSave={currentEntryUnavailable ? noop : handleSave}
              onSubmit={() => {
                if (branchNameState) handleSubmit(branchNameState).catch(console.error)
              }}
              onWithdraw={() => {
                if (branchNameState) handleWithdraw(branchNameState).catch(console.error)
              }}
            />
          }
          banner={
            <BranchLockBanner
              branchName={branchNameState}
              branchStatus={currentBranch?.status}
              branchReadOnly={currentBranch?.readOnly}
              branchWriteBlocked={branchContentLocked}
              onBranchManagerOpen={openBranchManager}
            />
          }
          rail={
            <EditorRail
              siteTitle={siteTitle}
              onHomeOpen={() => {
                const first = entriesState[0]
                if (first) openEntry(first.path)
              }}
              contentPanelOpen={contentPanelShown}
              contentPanelId={CONTENT_PANEL_ID}
              onContentToggle={() =>
                contentPanelShown ? setContentPanelShown(false) : openNavigator()
              }
              onQuickOpen={openQuickOpen}
              quickOpenShortcut={quickOpenShortcut}
              quickOpenKeys={quickOpenKeys}
              branchesOpen={branchManagerOpen}
              onBranchesOpen={openBranchManager}
              onCommentsOpen={
                clientOperatingStrategy(operatingMode ?? 'prod').supportsComments() &&
                branchNameState
                  ? () => setCommentsPanelOpen(true)
                  : undefined
              }
              commentsOpen={commentsPanelOpen}
              unresolvedCommentCount={comments.filter((t) => !t.resolved).length}
              mediaLibraryOpen={mediaLibraryOpen}
              onMediaLibraryOpen={() => setMediaLibraryOpen(true)}
              mediaButtonRef={mediaButtonRef}
              onPermissionManagerOpen={
                userIsAdmin ? () => setPermissionManagerOpen(true) : undefined
              }
              onGroupManagerOpen={userIsAdmin ? () => setGroupManagerOpen(true) : undefined}
              onSystemHealthOpen={userIsAdmin ? () => setSystemHealthOpen(true) : undefined}
              settingsToggleRef={settingsToggleRef}
              AccountComponent={AccountComponent}
              onAccountClick={onAccountClick}
              onLogoutClick={onLogoutClick}
            />
          }
          panel={contentPanelDocked ? contentPanel : undefined}
          main={
            <Box h="100%">
              <PaneLayout
                formOverlay={contentPanelDocked ? undefined : contentPanel}
                formInert={contentOverlayShown}
                previewMaximized={previewShownMaximized}
                // Sizing the pane, by pointer or key, gives the page the pane's width.
                onSeparatorDrag={(dragging) => {
                  setPaneResizing(dragging)
                  if (dragging) setPreviewWidth('fit')
                }}
                arrangement={layout}
                sideSplitPercent={sideSplitPercent}
                stackedSplitPercent={stackedSplitPercent}
                onSplitPercentChange={(arrangement, percent) => {
                  setSplitPercent(arrangement, percent)
                  setPreviewWidth('fit')
                }}
                preview={
                  renderPreview && currentEntry && !currentEntryUnavailable
                    ? renderPreview(currentEntry, displayValue)
                    : defaultPreview
                }
                form={
                  !currentEntry ? (
                    <CenteredMessage>
                      {!branchNameState && busy
                        ? 'Setting up your branch workspace…'
                        : entriesInitializing
                          ? 'Loading content…'
                          : 'Select an item to start editing.'}
                    </CenteredMessage>
                  ) : currentEntryUnavailable ? (
                    <UnavailableEntryNotice
                      schemaRefs={
                        currentEntry.unavailable ? [currentEntry.unavailable.schemaRef] : []
                      }
                    />
                  ) : currentEntry.canEdit === false ? (
                    <NoEditPermissionNotice entryLabel={currentEntry.label} />
                  ) : schema.length > 0 && displayValue ? (
                    <EntryLinkContext.Provider value={entryLinkContextValue}>
                      <SiteMdxAllowContext.Provider value={mdxAllow}>
                        <FormRenderer
                          notice={
                            hiddenDraftNotice && (
                              <ReadOnlyDraftNotice
                                permanentlyReadOnly={
                                  (currentBranch?.isProtected ?? true) ||
                                  currentBranch?.status === 'archived'
                                }
                                // A hidden draft's discard changes nothing on screen, so it says so.
                                onDiscard={() =>
                                  handleDiscardFileDraft(() => navigatorToggleRef.current, {
                                    announce: true,
                                  })
                                }
                              />
                            )
                          }
                          fields={schema}
                          value={displayValue}
                          readOnly={contentReadOnly}
                          onRemoved={handleFieldRemoved}
                          commentBlockedReason={commentBlockedReason}
                          removedItemFieldLabel={commentFieldLabel}
                          onGetUserMetadata={getCommentUserMetadata}
                          header={{
                            title: currentEntry.label,
                            typeLabel: entryTypeLabel(activeCollections, currentEntry),
                          }}
                          // The one writer of drafts. Read-only content gets none, whatever a
                          // field emits (MDXEditor's mount-time normalisation included).
                          onChange={(next) => {
                            const contentId = currentEntry?.contentId
                            if (contentId && !contentReadOnlyRef.current) {
                              // Every list item keeps a key, whatever field made it.
                              const keyed = withItemKeys(schema, next, 'random')
                              setDrafts((prev) => ({ ...prev, [contentId]: keyed }))
                            }
                          }}
                          customRenderers={customRenderers}
                          branch={branchNameState}
                          comments={displayComments}
                          currentEntryPath={selectedPath}
                          currentUserId={commentUserId}
                          canResolve={canResolveAnyComment}
                          focusedFieldPath={focusedFieldPath}
                          highlightThreadId={highlightThreadId}
                          onAddComment={handleAddDisplayedComment}
                          onResolveThread={handleResolveThread}
                          fieldErrors={fieldErrors}
                          format={currentEntry.format}
                          conflictNotice={
                            !!(
                              currentEntry?.contentId &&
                              currentBranch?.conflictFiles?.includes(currentEntry.contentId)
                            )
                          }
                        />
                      </SiteMdxAllowContext.Provider>
                    </EntryLinkContext.Provider>
                  ) : schema.length === 0 ? (
                    <CenteredMessage>No fields to edit.</CenteredMessage>
                  ) : loadFailedKey !== `${branchNameState}:${currentEntry.contentId}` ? (
                    <Stack gap="lg" p="md" data-testid="entry-loading-skeleton">
                      {[0, 1, 2].map((row) => (
                        <Stack key={row} gap={6}>
                          <Skeleton h={12} w={120} />
                          <Skeleton h={36} />
                        </Stack>
                      ))}
                    </Stack>
                  ) : (
                    <Alert
                      color="red"
                      variant="light"
                      m="md"
                      title="This entry couldn't be loaded."
                      data-testid="entry-load-failed"
                    >
                      <Button
                        variant="default"
                        onClick={() => {
                          setLoadFailedKey(null)
                          setLoadAttempt((attempt) => attempt + 1)
                        }}
                      >
                        Retry
                      </Button>
                    </Alert>
                  )
                }
              />
            </Box>
          }
          overlays={
            <>
              <QuickOpenPalette
                opened={quickOpenOpen}
                onOpen={openQuickOpen}
                onClose={() => setQuickOpenOpen(false)}
                returnFocusTo={quickOpenFromOverlay ? navigatorReturnTarget : undefined}
                entries={entriesState}
                // The hidden root's entries sit at the top of the tree, so they get no heading here either.
                collectionLabel={(path) =>
                  path === hiddenRootPath ? '' : collectionLabels.get(path)
                }
                onSelect={setSelectedPath}
              />
              <BranchesDrawer
                opened={branchManagerOpen}
                onClose={() => setBranchManagerOpen(false)}
                confirmOpen={branchConfirmOpen}
                returnFocusTo={branchReturnTarget}
              >
                <BranchManager
                  branches={branchSummaries}
                  mode={operatingMode}
                  user={userContext}
                  currentBranchName={currentBranch?.name ?? branchNameState}
                  onSelect={async (name) => {
                    try {
                      await handleBranchChange(name)
                      setBranchManagerOpen(false)
                    } catch (err) {
                      console.error('Branch change failed or was cancelled:', err)
                      // Don't close branch manager if there was an error or user cancelled
                    }
                  }}
                  onBeforeCreate={confirmCreateBranch}
                  onCreate={handleCreateBranch}
                  onSubmit={(name) => {
                    handleSubmit(name).catch((err) => console.error(err))
                  }}
                  onWithdraw={(name) => {
                    handleWithdraw(name).catch((err) => console.error(err))
                  }}
                  onRequestChanges={(name) => {
                    handleRequestChanges(name).catch((err) => console.error(err))
                  }}
                  onDelete={(name) => {
                    handleDelete(name).catch((err) => console.error(err))
                  }}
                  onClose={() => setBranchManagerOpen(false)}
                  comments={comments}
                  currentUserId={commentUserId}
                  canResolve={canResolveAnyComment}
                  onAddComment={handleAddComment}
                  onResolveThread={handleResolveThread}
                  highlightThreadId={highlightThreadId}
                  onGetUserMetadata={canResolveUserNames ? handleGetUserMetadata : undefined}
                  onGetOwnerMetadata={getCommentUserMetadata}
                  onGetCommentUserMetadata={getCommentUserMetadata}
                />
              </BranchesDrawer>
              {branchNameState && (
                <CommentsPanel
                  key={branchNameState}
                  opened={commentsPanelOpen}
                  branchName={branchNameState}
                  comments={displayComments}
                  canResolve={canResolveAnyComment}
                  currentUserId={commentUserId}
                  entryLabel={commentEntryLabel}
                  fieldLabel={commentFieldLabel}
                  onAddComment={handleAddDisplayedComment}
                  onResolveThread={handleResolveThread}
                  onClose={() => setCommentsPanelOpen(false)}
                  onJumpToField={jumpToThreadField}
                  onGetUserMetadata={getCommentUserMetadata}
                  onJumpToEntry={handleJumpToEntry}
                  onJumpToBranch={handleJumpToBranch}
                />
              )}

              {userIsAdmin && (
                <GroupManager
                  opened={groupManagerOpen}
                  onClose={() => setGroupManagerOpen(false)}
                  returnFocusTo={settingsReturnTarget}
                  internalGroups={groupsData}
                  loading={groupsLoading}
                  canEdit={userIsAdmin}
                  onSave={handleSaveGroups}
                  onSearchUsers={handleSearchUsers}
                  onGetUserMetadata={handleGetUserMetadata}
                  onSearchExternalGroups={handleSearchExternalGroups}
                />
              )}

              {userIsAdmin && (
                <PermissionManager
                  opened={permissionManagerOpen}
                  onClose={() => setPermissionManagerOpen(false)}
                  returnFocusTo={settingsReturnTarget}
                  collections={activeCollections}
                  contentRoot={contentRoot}
                  permissions={permissionsData}
                  loading={permissionsLoading}
                  canEdit={userIsAdmin}
                  onSave={handleSavePermissions}
                  onSearchUsers={handleSearchUsers}
                  onGetUserMetadata={handleGetUserMetadata}
                  onListGroups={handleListGroups}
                />
              )}

              {userIsAdmin && (
                <SystemHealthPanel
                  opened={systemHealthOpen}
                  onClose={() => setSystemHealthOpen(false)}
                  returnFocusTo={settingsReturnTarget}
                />
              )}

              <MediaLibrary
                opened={mediaLibraryOpen}
                onClose={() => setMediaLibraryOpen(false)}
                mode="manage"
                returnFocusTo={() => mediaButtonRef.current}
              />

              {userIsAdmin && (
                <CollectionEditor
                  isOpen={collectionEditorOpen}
                  editingCollection={editingCollection}
                  parentPath={collectionEditorParentPath}
                  availableSchemas={availableSchemas}
                  onSave={handleCollectionSave}
                  onAddEntryType={
                    editingCollection
                      ? (path, entryType) => addEntryType(path, entryType)
                      : undefined
                  }
                  onUpdateEntryType={
                    editingCollection
                      ? (path, name, updates) => updateEntryType(path, name, updates)
                      : undefined
                  }
                  onRemoveEntryType={
                    editingCollection ? (path, name) => removeEntryType(path, name) : undefined
                  }
                  onReloadEntryTypes={editingCollection ? readEntryTypes : undefined}
                  onClose={handleCloseCollectionEditor}
                  isSaving={schemaLoading}
                  error={collectionEditorError}
                  restored={restoredCollectionInput}
                  onDiscardRestored={() => {
                    collectionDraftRef.current = null
                    setRestoredCollectionInput(null)
                  }}
                />
              )}

              {renamingEntry && (
                <RenameEntryModal
                  isOpen={renameModalOpen}
                  entryLabel={renamingEntry.label}
                  currentSlug={renamingEntry.slug || ''}
                  onSave={handleRenameSubmit}
                  onClose={() => {
                    setRenameModalOpen(false)
                    setRenamingEntry(null)
                    setRenameModalError(null)
                  }}
                  isSaving={renameModalSaving}
                  error={renameModalError?.mayHaveLanded ? null : renameModalError?.message}
                  warning={renameModalError?.mayHaveLanded ? renameModalError.message : null}
                  existingSlugs={renameExistingSlugs}
                  previewPath={(slug) =>
                    previewPathFor({
                      collectionPath: renamingEntry.collectionPath ?? '',
                      collectionName: renamingEntry.collectionName,
                      slug,
                      entryType: renamingEntry.entryType,
                    })
                  }
                />
              )}

              {createModalCollection && (
                <EntryCreateModal
                  isOpen={createModalOpen}
                  collectionLabel={createModalCollection.label || createModalCollection.name}
                  entryTypes={createModalEntryTypes}
                  onCreate={handleCreateModalSubmit}
                  onClose={closeCreateModal}
                  isCreating={createModalCreating}
                  error={createModalError}
                  existingSlugs={createModalExistingSlugs}
                  previewPath={(slug, entryTypeName) =>
                    previewPathFor({
                      collectionPath: createModalCollection.path,
                      collectionName: createModalCollection.name,
                      slug,
                      entryType: entryTypeName,
                    })
                  }
                />
              )}

              <ConfirmDeleteModal
                isOpen={deleteCollectionModalOpen}
                title="Delete Collection"
                message="Are you sure you want to delete this collection? This cannot be undone."
                confirmLabel="Delete Collection"
                onConfirm={confirmDeleteCollection}
                onClose={() => {
                  setDeleteCollectionModalOpen(false)
                  setDeletingCollectionPath(null)
                }}
                loading={deleteInProgress}
              />

              <ConfirmDeleteModal
                isOpen={deleteEntryModalOpen}
                title="Delete Entry"
                message={
                  deletingEntryReferencedBy
                    ? referencedDeleteMessage(deletingEntryReferencedBy)
                    : 'Are you sure you want to delete this entry? This cannot be undone.'
                }
                confirmLabel={deletingEntryReferencedBy ? 'Delete anyway' : 'Delete Entry'}
                onConfirm={confirmDeleteEntry}
                onClose={closeDeleteEntryModal}
                loading={deleteInProgress}
              >
                {deletingEntryReferencedBy && (
                  <ReferencedByList
                    referencedBy={deletingEntryReferencedBy}
                    onOpenEntry={(entryPath) => {
                      closeDeleteEntryModal()
                      openEntry(entryPath)
                    }}
                  />
                )}
              </ConfirmDeleteModal>
            </>
          }
        />
      </AssetContextProvider>
    </CanopyCMSProvider>
  )
}

export default Editor
