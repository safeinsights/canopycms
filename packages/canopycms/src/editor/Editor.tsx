'use client'

import React, { useEffect, useMemo, useState, useRef } from 'react'

import { ActionIcon, Box, Drawer, Group, Menu, Paper, Text, Title, useTree } from '@mantine/core'
import { IconChevronDown, IconChevronUp, IconDots, IconFolderPlus, IconPlus } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'

// TreeController type from Mantine's useTree hook
type TreeController = ReturnType<typeof useTree>

import type { ContentFormat, FieldConfig } from '../config'
import { EntryNavigator, type EntryNavCollection } from './EntryNavigator'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { PreviewFrame } from './preview-bridge'
import type { OperatingMode } from '../operating-mode'
import { EditorPanes } from './EditorPanes'
import { CanopyCMSProvider, type CanopyThemeOptions } from './theme'
import { BranchManager } from './BranchManager'
import { CommentsPanel } from './CommentsPanel'
import { GroupManager } from './GroupManager'
import { PermissionManager } from './PermissionManager'
import type { CommentThread } from '../comment-store'
import { buildPreviewSrc, buildCollectionLabels, buildBreadcrumbSegments } from './editor-utils'
import { useEditorLayout, useDraftManager, useEntryManager, useGroupManager, usePermissionManager, useCommentSystem, useBranchManager, useUserContext, useSchemaManager } from './hooks'
import { useBranchActions } from './hooks/useBranchActions'
import { EditorFooter, EditorHeader, EditorSidebar } from './components'
import { CollectionEditor, type ExistingCollection, type ExistingEntryType } from './schema-editor'
import type { LogicalPath } from '../paths/types'
import { toLogicalPath } from '../paths/normalize'
import { useApiClient } from './context'

export interface EditorEntry {
  path: string // Logical path (no IDs/extensions)
  contentId?: string // 12-char content ID (optional for test data)
  label: string
  status?: string
  schema: readonly FieldConfig[]
  apiPath: string
  previewSrc?: string
  collectionId?: string
  collectionName?: string
  slug?: string
  format?: ContentFormat
  type?: 'entry'
  canEdit?: boolean
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
}

export interface EditorCollection {
  path: string // Logical path
  contentId?: string // 12-char content ID (optional, from directory name)
  name: string
  label?: string
  format: ContentFormat // Default entry type's format (for backwards compatibility)
  type: 'collection' | 'entry'
  entryTypes?: EditorEntryType[] // All entry types in this collection
  order?: readonly string[] // Embedded IDs for ordering entries and children
  children?: EditorCollection[]
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
  initialSelectedId?: string
  initialValues?: Record<string, FormValue>
  renderPreview?: (entry: EditorEntry, value: FormValue | undefined) => React.ReactNode
  onCreateEntry?: (collectionId: string) => Promise<void> | void
  themeOptions?: CanopyThemeOptions
  previewBaseByCollection?: Record<string, string>
  currentUser?: string
  canResolveComments?: boolean
  // Auth UI handlers from config
  AccountComponent?: React.ComponentType
  onAccountClick?: () => void
  onLogoutClick?: () => void
}

/**
 * High-level editor wrapper that wires entry navigation, form rendering,
 * saving/loading, and preview rendering using entry definitions.
 */
export const Editor: React.FC<EditorProps> = ({
  entries,
  title,
  subtitle,
  siteTitle = title,
  siteSubtitle = subtitle,
  branchName = '',
  collections,
  contentRoot,
  initialSelectedId,
  initialValues,
  renderPreview,
  onCreateEntry,
  themeOptions,
  operatingMode,
  previewBaseByCollection,
  currentUser = 'current-user',
  canResolveComments = true,
  AccountComponent,
  onAccountClick,
  onLogoutClick,
}) => {
  // Per-resource loading states
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const busy = branchesLoading || entriesLoading || commentsLoading

  const [groupManagerOpen, setGroupManagerOpen] = useState(false)
  const [permissionManagerOpen, setPermissionManagerOpen] = useState(false)
  const [branchManagerOpen, setBranchManagerOpen] = useState(false)

  // Schema editor state
  const [collectionEditorOpen, setCollectionEditorOpen] = useState(false)
  const [editingCollection, setEditingCollection] = useState<ExistingCollection | null>(null)
  const [collectionEditorParentPath, setCollectionEditorParentPath] = useState<LogicalPath | undefined>(undefined)
  const [collectionEditorError, setCollectionEditorError] = useState<string | null>(null)
  const [availableSchemas, setAvailableSchemas] = useState<string[]>([])

  // Preview data with resolved references for live preview
  const [previewData, setPreviewData] = useState<FormValue>({})
  const [previewLoadingState, setPreviewLoadingState] = useState<FormValue>({})

  // API client for schema operations
  const apiClient = useApiClient()

  // Fetch current user context for permission checks
  const { userContext } = useUserContext()

  // Use custom hooks for layout, entry, draft, group, permission, comment, and branch management
  const { layout, setLayout, highlightEnabled, setHighlightEnabled, headerRef, headerHeight } = useEditorLayout()

  // Comments state (shared between useCommentSystem and useBranchManager)
  const [commentsForBranchSummaries, setCommentsForBranchSummaries] = useState<CommentThread[]>([])

  // 1. Branch manager (provides branchNameState, no dependencies)
  const {
    branchName: branchNameState,
    setBranchName,
    branches,
    branchSummaries,
    currentBranch,
    handleSubmit,
    handleWithdraw,
    handleRequestChanges,
    handleReloadBranchData,
    loadBranches,
  } = useBranchManager({
    initialBranch: branchName,
    operatingMode,
    setBusy: setBranchesLoading,
    comments: commentsForBranchSummaries,
  })

  // 2. Entry manager (depends on branchNameState, owns selectedPath)
  const {
    selectedPath,
    setSelectedPath,
    entries: entriesState,
    setEntries: setEntriesState,
    collections: collectionsFromApi,
    currentEntry,
    navigatorOpen,
    setNavigatorOpen,
    refreshEntries,
    handleCreateEntry,
    loadEntry,
    saveEntry,
  } = useEntryManager({
    initialEntries: entries,
    initialSelectedId,
    branchName: branchNameState,
    collections,
    previewBaseByCollection,
    resolvePreviewSrc: (entry) => buildPreviewSrc(entry, { branchName: branchNameState, previewBaseByCollection, contentRoot }),
    setBusy: setEntriesLoading,
    contentRoot,
  })

  // Use collections from API (falls back to props if not loaded yet)
  const activeCollections = collectionsFromApi.length > 0 ? collectionsFromApi : collections

  // 3. Draft manager (depends on branchNameState, selectedPath from useEntryManager)
  const {
    drafts,
    setDrafts,
    loadedValues,
    setLoadedValues,
    effectiveValue,
    modifiedCount,
    editedFiles,
    handleSave,
    handleDiscardDrafts,
    handleDiscardFileDraft,
    handleReload,
    isSelectedDirty,
  } = useDraftManager({
    branchName: branchNameState,
    selectedPath,
    currentEntry,
    entries: entriesState,
    initialValues,
    loadEntry,
    saveEntry,
    setBusy: setEntriesLoading,
  })

  // 4. Branch actions (depends on isSelectedDirty, setBranchName)
  const { handleBranchChange, handleCreateBranch } = useBranchActions({
    branchName: branchNameState,
    setBranchName,
    isSelectedDirty,
    onReloadBranches: () => loadBranches(),
  })

  // 5. Comment system (depends on branchNameState)
  const {
    comments,
    focusedFieldPath,
    highlightThreadId,
    commentsPanelOpen,
    setCommentsPanelOpen,
    handleAddComment,
    handleResolveThread,
    loadComments,
    handleJumpToField,
    handleJumpToEntry,
    handleJumpToBranch,
  } = useCommentSystem({
    branchName: branchNameState,
    selectedPath,
    currentEntry,
    currentUser,
    canResolveComments,
    setSelectedPath,
    setBranchManagerOpen,
    onCommentsChange: setCommentsForBranchSummaries,
  })

  const {
    groupsData,
    groupsLoading,
    handleSaveGroups,
    handleSearchUsers,
    handleGetUserMetadata,
    handleSearchExternalGroups,
  } = useGroupManager({ isOpen: groupManagerOpen })

  const { permissionsData, permissionsLoading, handleSavePermissions, handleListGroups } = usePermissionManager({
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

  const flattenedCollections = useMemo(() => {
    const all: EditorCollection[] = []
    const walk = (nodes?: EditorCollection[]) => {
      nodes?.forEach((node) => {
        all.push(node)
        if (node.children) {
          walk(node.children)
        }
      })
    }
    walk(activeCollections)
    return all
  }, [activeCollections])
  const collectionLabels = useMemo(() => buildCollectionLabels(activeCollections), [activeCollections])
  const schema = currentEntry?.schema ?? []
  const previewKey = currentEntry?.previewSrc ?? currentEntry?.path

  // Effect to load entry data when selection changes
  useEffect(() => {
    const load = async () => {
      if (!currentEntry || drafts[selectedPath]) return
      setEntriesLoading(true)
      try {
        const loaded = await loadEntry(currentEntry)
        setLoadedValues((prev) => ({ ...prev, [selectedPath]: loaded }))
        setDrafts((prev) => ({ ...prev, [selectedPath]: loaded }))
      } catch (err) {
        console.error(err)
        notifications.show({ message: 'Failed to load entry', color: 'red' })
      } finally {
        setEntriesLoading(false)
      }
    }
    load().catch((err) => {
      console.error(err)
      setEntriesLoading(false)
      notifications.show({ message: 'Failed to load entry', color: 'red' })
    })
  }, [currentEntry, drafts, selectedPath])

  // Load available schemas when branch changes
  useEffect(() => {
    if (!branchNameState) return
    const loadSchemas = async () => {
      try {
        const result = await apiClient.schema.get({ branch: branchNameState })
        if (result.ok && result.data) {
          setAvailableSchemas(result.data.availableSchemas ?? [])
        }
      } catch (err) {
        console.error('Failed to load available schemas:', err)
      }
    }
    loadSchemas()
  }, [branchNameState, apiClient])

  // Schema editor handlers
  const handleOpenCollectionEditor = (collection: EditorCollection | null, parentPath?: string) => {
    if (collection) {
      // Edit mode - convert EditorCollection to ExistingCollection
      const existingCollection: ExistingCollection = {
        name: collection.name,
        label: collection.label,
        logicalPath: toLogicalPath(collection.path),
        entries: (collection.entryTypes ?? []).map((et): ExistingEntryType => ({
          name: et.name,
          label: et.label,
          format: et.format,
          fields: '', // Will be populated from schema when we have full entry type data
          default: et.default,
          maxItems: et.maxItems,
        })),
      }
      setEditingCollection(existingCollection)
      setCollectionEditorParentPath(undefined)
    } else {
      // Create mode
      setEditingCollection(null)
      setCollectionEditorParentPath(parentPath ? toLogicalPath(parentPath) : undefined)
    }
    setCollectionEditorError(null)
    setCollectionEditorOpen(true)
  }

  const handleCloseCollectionEditor = () => {
    setCollectionEditorOpen(false)
    setEditingCollection(null)
    setCollectionEditorParentPath(undefined)
    setCollectionEditorError(null)
  }

  const handleCollectionSave = async (data: Parameters<typeof createCollection>[0] | Parameters<typeof updateCollection>[1], isNew: boolean) => {
    setCollectionEditorError(null)
    try {
      if (isNew) {
        const result = await createCollection(data as Parameters<typeof createCollection>[0])
        if (result) {
          handleCloseCollectionEditor()
        }
      } else if (editingCollection) {
        const success = await updateCollection(editingCollection.logicalPath, data as Parameters<typeof updateCollection>[1])
        if (success) {
          handleCloseCollectionEditor()
        }
      }
    } catch (err) {
      setCollectionEditorError(err instanceof Error ? err.message : 'Operation failed')
    }
  }

  const handleDeleteCollection = async (collectionPath: string) => {
    // Confirm deletion
    if (!window.confirm(`Are you sure you want to delete this collection? This cannot be undone.`)) {
      return
    }
    await deleteCollection(collectionPath)
  }

  const handleDeleteEntry = async (entryPath: string) => {
    // Confirm deletion
    if (!window.confirm(`Are you sure you want to delete this entry? This cannot be undone.`)) {
      return
    }
    const success = await deleteEntry(entryPath)
    if (success && selectedPath === entryPath) {
      // If we deleted the currently selected entry, clear selection
      setSelectedPath('')
    }
  }

  const handleReorderEntry = async (collectionPath: string, contentId: string, direction: 'up' | 'down') => {
    // Find the collection to get its current order array
    const findCollection = (cols: EditorCollection[] | undefined, path: string): EditorCollection | undefined => {
      if (!cols) return undefined
      for (const col of cols) {
        if (col.path === path) return col
        const found = findCollection(col.children, path)
        if (found) return found
      }
      return undefined
    }
    const collection = findCollection(activeCollections, collectionPath)
    if (!collection) return

    // Use the collection's order array as the source of truth
    // If no order array exists, build one from current entries and children
    let currentOrder: string[]
    if (collection.order && collection.order.length > 0) {
      currentOrder = [...collection.order]
    } else {
      // Fallback: build order from entries and children
      const collectionEntries = entriesState.filter((e) => e.collectionId === collectionPath)
      const entryIds = collectionEntries.map((e) => e.contentId).filter((id): id is string => !!id)
      const subCollectionIds = (collection.children ?? [])
        .map((child) => child.contentId)
        .filter((id): id is string => !!id)
      currentOrder = [...entryIds, ...subCollectionIds]
    }

    // Find current position
    const currentIndex = currentOrder.indexOf(contentId)
    if (currentIndex === -1) return

    // Calculate new position
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (newIndex < 0 || newIndex >= currentOrder.length) return

    // Swap positions
    const newOrder = [...currentOrder]
    ;[newOrder[currentIndex], newOrder[newIndex]] = [newOrder[newIndex], newOrder[currentIndex]]

    // Update via API
    await updateOrder(collectionPath, newOrder)
  }

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
      if (!entry.collectionId) return
      const list = grouped.get(entry.collectionId) ?? []
      list.push({ path: entry.path, label: entry.label, status: entry.status, contentId: entry.contentId })
      grouped.set(entry.collectionId, list)
    })

    const build = (node: EditorCollection): EntryNavCollection => {
      const entries = grouped.get(node.path) ?? []
      const children = node.children?.map((child) => build(child)) ?? []

      // Pass entries, children, and order to EntryNavigator for interleaved ordering
      return {
        path: node.path,
        label: node.label ?? node.name,
        type: node.type,
        contentId: node.contentId,
        order: node.order,
        entries: entries.length > 0 ? entries : undefined,
        children: children.length > 0 ? children : undefined,
        onAdd:
          node.type !== 'entry'
            ? () => (onCreateEntry ? onCreateEntry(node.path) : handleCreateEntry(node.path))
            : undefined,
        onEdit:
          node.type === 'collection'
            ? () => handleOpenCollectionEditor(node)
            : undefined,
        onAddSubCollection:
          node.type === 'collection'
            ? () => handleOpenCollectionEditor(null, node.path)
            : undefined,
        onDelete:
          node.type === 'collection'
            ? () => handleDeleteCollection(node.path)
            : undefined,
      }
    }
    return activeCollections.map((node) => build(node))
  }, [activeCollections, entriesState, onCreateEntry, handleCreateEntry, contentRoot])

  // Tree expansion state - persists across drawer close/open
  const treeExpandedStateRef = useRef<Record<string, boolean>>({})

  // Tree controller ref for collapse/expand all functionality
  const treeControllerRef = useRef<TreeController | null>(null)

  const handleTreeControllerReady = (controller: TreeController) => {
    treeControllerRef.current = controller
  }

  const handleExpandedStateChange = (state: Record<string, boolean>) => {
    treeExpandedStateRef.current = state
  }

  const handleCollapseAll = () => {
    treeControllerRef.current?.collapseAllNodes()
    // Sync the ref to empty state
    treeExpandedStateRef.current = {}
  }

  const handleExpandAll = () => {
    treeControllerRef.current?.expandAllNodes()
    // Sync the ref with all expanded nodes from controller
    treeExpandedStateRef.current = treeControllerRef.current?.expandedState ?? {}
  }

  const previewFrameData = Object.keys(previewData).length > 0 ? previewData : effectiveValue

  // Helper component for centered messages
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

  const defaultPreview =
    currentEntry?.previewSrc && previewFrameData ? (
      <PreviewFrame
        src={currentEntry.previewSrc}
        path={currentEntry.previewSrc}
        data={previewFrameData}
        isLoading={previewLoadingState}
        style={{
          width: '100%',
          height: '100%',
          border: '1px solid var(--mantine-color-gray-3)',
        }}
        highlightEnabled={highlightEnabled}
      />
    ) : (
      <Paper
        withBorder
        shadow="xs"
        h="100%"
        bg="white"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Text size="sm" c="dimmed">
          Select an item to start editing.
        </Text>
      </Paper>
    )

  const sidebarWidth = 64
  const footerHeight = 40

  const headerTitle = currentEntry?.label ?? currentEntry?.slug ?? title
  const breadcrumbSegments = useMemo(
    () => buildBreadcrumbSegments(currentEntry, collectionLabels),
    [collectionLabels, currentEntry]
  )

  return (
    <CanopyCMSProvider {...(themeOptions ?? {})}>
      <Box bg="gray.0" style={{ minHeight: '100vh', width: '100%' }}>
        <EditorHeader
          ref={headerRef}
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
          unresolvedCommentCount={comments.filter((t) => !t.resolved).length}
          comments={comments}
          hasUnsavedChanges={isSelectedDirty()}
          userContext={userContext}
          branchCreatedBy={currentBranch?.createdBy}
          branchAccess={currentBranch?.access}
          onNavigatorOpen={() => setNavigatorOpen(true)}
          onFileReload={handleReload}
          onFileDiscardDraft={handleDiscardFileDraft}
          onEntrySelect={setSelectedPath}
          onBranchReloadData={handleReloadBranchData}
          onBranchDiscardDrafts={handleDiscardDrafts}
          onBranchManagerOpen={() => setBranchManagerOpen(true)}
          onCommentsPanelOpen={() => setCommentsPanelOpen(true)}
          onSave={handleSave}
          onSubmit={() => branchNameState && handleSubmit(branchNameState)}
          onWithdraw={() => branchNameState && handleWithdraw(branchNameState)}
        />

        <Box
          style={{
            paddingTop: headerHeight,
            paddingBottom: footerHeight,
            paddingRight: sidebarWidth,
            minHeight: '100vh',
            width: '100%',
          }}
        >
          <Box
            style={{
              height: `calc(100vh - ${headerHeight + footerHeight}px)`,
              minHeight: 0,
              position: 'relative',
            }}
          >
            <Box style={{ flex: 1, minHeight: 0, height: '100%', width: '100%' }}>
              <EditorPanes
                layout={layout}
                onLayoutChange={(next) => setLayout(next)}
                preview={renderPreview && currentEntry ? renderPreview(currentEntry, effectiveValue) : defaultPreview}
                form={
                  !currentEntry ? (
                    <CenteredMessage>Select an item to start editing.</CenteredMessage>
                  ) : currentEntry.canEdit === false ? (
                    <CenteredMessage>You don't have permission to edit this content.</CenteredMessage>
                  ) : schema.length > 0 && effectiveValue ? (
                    <FormRenderer
                      fields={schema}
                      value={effectiveValue}
                      onChange={(next) => setDrafts((prev) => ({ ...prev, [selectedPath]: next }))}
                      branch={branchNameState}
                      onResolvedValueChange={setPreviewData}
                      onLoadingStateChange={setPreviewLoadingState}
                      comments={comments}
                      currentEntryPath={selectedPath}
                      currentUserId={currentUser}
                      canResolve={canResolveComments}
                      focusedFieldPath={focusedFieldPath}
                      highlightThreadId={highlightThreadId}
                      onAddComment={handleAddComment}
                      onResolveThread={handleResolveThread}
                    />
                  ) : (
                    <CenteredMessage>No fields to edit.</CenteredMessage>
                  )
                }
              />
            </Box>
            <EditorSidebar
              layout={layout}
              highlightEnabled={highlightEnabled}
              sidebarWidth={sidebarWidth}
              headerHeight={headerHeight}
              footerHeight={footerHeight}
              onLayoutChange={setLayout}
              onHighlightToggle={() => setHighlightEnabled(!highlightEnabled)}
              onPermissionManagerOpen={() => setPermissionManagerOpen(true)}
              onGroupManagerOpen={() => setGroupManagerOpen(true)}
              AccountComponent={AccountComponent}
              onAccountClick={onAccountClick}
              onLogoutClick={onLogoutClick}
            />
          </Box>
        </Box>

        <EditorFooter />

        <Drawer.Root opened={navigatorOpen} onClose={() => setNavigatorOpen(false)} position="left" size={360}>
          <Drawer.Overlay blur={2} />
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title>Content</Drawer.Title>
              <Group gap="xs">
                {navCollections && navCollections.length > 0 && (navCollections[0].onAdd || navCollections[0].onAddSubCollection) && (
                  <Menu shadow="md" width={200} withinPortal position="bottom-end">
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label="Content actions"
                      >
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {navCollections[0].onAdd && (
                        <Menu.Item
                          leftSection={<IconPlus size={14} />}
                          onClick={() => navCollections[0].onAdd?.()}
                        >
                          Add Entry
                        </Menu.Item>
                      )}
                      {navCollections[0].onAddSubCollection && (
                        <Menu.Item
                          leftSection={<IconFolderPlus size={14} />}
                          onClick={() => navCollections[0].onAddSubCollection?.()}
                        >
                          Add Collection
                        </Menu.Item>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                )}
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  onClick={handleCollapseAll}
                  title="Collapse all folders"
                  aria-label="Collapse all folders"
                >
                  <IconChevronUp size={16} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  onClick={handleExpandAll}
                  title="Expand all folders"
                  aria-label="Expand all folders"
                >
                  <IconChevronDown size={16} />
                </ActionIcon>
                <Drawer.CloseButton />
              </Group>
            </Drawer.Header>
            <Drawer.Body p={0}>
              <Box px="md">
                <EntryNavigator
                  collections={navCollections}
                  items={
                    navCollections
                      ? undefined
                      : entriesState.map((e) => ({ path: e.path, label: e.label, status: e.status }))
                  }
                  selectedPath={selectedPath}
                  onSelect={(id) => {
                    setSelectedPath(id)
                    setNavigatorOpen(false)
                  }}
                  onTreeControllerReady={handleTreeControllerReady}
                  expandedStateRef={treeExpandedStateRef}
                  onExpandedStateChange={handleExpandedStateChange}
                  onDeleteEntry={handleDeleteEntry}
                  onReorderEntry={handleReorderEntry}
                  hiddenRootPath={hiddenRootPath}
                />
              </Box>
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Root>
        <Drawer
          opened={branchManagerOpen}
          onClose={() => setBranchManagerOpen(false)}
          position="right"
          title={
            <div>
              <Title order={4}>Branches</Title>
              <Text size="xs" c="dimmed">
                Manage access, status, and lifecycle
              </Text>
            </div>
          }
          padding="md"
          size={420}
          overlayProps={{ blur: 2 }}
        >
          <BranchManager
            branches={branchSummaries}
            mode={operatingMode}
            user={userContext}
            onSelect={async (name) => {
              try {
                await handleBranchChange(name)
                setBranchManagerOpen(false)
              } catch (err) {
                console.error('Branch change failed or was cancelled:', err)
                // Don't close branch manager if there was an error or user cancelled
              }
            }}
            onCreate={(branch) => {
              handleCreateBranch(branch).catch((err) => console.error(err))
            }}
            onSubmit={(name) => {
              handleSubmit(name).catch((err) => console.error(err))
            }}
            onWithdraw={(name) => {
              handleWithdraw(name).catch((err) => console.error(err))
            }}
            onRequestChanges={(name) => {
              handleRequestChanges(name).catch((err) => console.error(err))
            }}
            onClose={() => setBranchManagerOpen(false)}
            comments={comments}
            currentUserId={currentUser}
            canResolve={canResolveComments}
            onAddComment={handleAddComment}
            onResolveThread={handleResolveThread}
            highlightThreadId={highlightThreadId}
            onGetUserMetadata={handleGetUserMetadata}
          />
        </Drawer>
        {commentsPanelOpen && branchNameState && (
          <CommentsPanel
            branchName={branchNameState}
            comments={comments}
            canResolve={true}
            onAddComment={handleAddComment}
            onResolveThread={handleResolveThread}
            onClose={() => setCommentsPanelOpen(false)}
            onJumpToField={handleJumpToField}
            onGetUserMetadata={handleGetUserMetadata}
            onJumpToEntry={handleJumpToEntry}
            onJumpToBranch={handleJumpToBranch}
          />
        )}

        {/* Group Manager Modal */}
        <Drawer
          opened={groupManagerOpen}
          onClose={() => setGroupManagerOpen(false)}
          position="right"
          title={
            <div>
              <Title order={4}>Groups</Title>
              <Text size="xs" c="dimmed">
                Manage groups and organizations
              </Text>
            </div>
          }
          padding="md"
          size={600}
          overlayProps={{ blur: 2 }}
        >
          <GroupManager
            internalGroups={groupsData}
            loading={groupsLoading}
            canEdit={true}
            onSave={handleSaveGroups}
            onSearchUsers={handleSearchUsers}
            onGetUserMetadata={handleGetUserMetadata}
            onSearchExternalGroups={handleSearchExternalGroups}
            onClose={() => setGroupManagerOpen(false)}
          />
        </Drawer>

        {/* Permission Manager Modal */}
        <Drawer
          opened={permissionManagerOpen}
          onClose={() => setPermissionManagerOpen(false)}
          position="right"
          title={
            <div>
              <Title order={4}>Permissions</Title>
              <Text size="xs" c="dimmed">
                Manage content access by path (read, edit, review)
              </Text>
            </div>
          }
          padding="md"
          size={700}
          overlayProps={{ blur: 2 }}
        >
          <PermissionManager
            collections={activeCollections}
            contentRoot={contentRoot}
            permissions={permissionsData}
            loading={permissionsLoading}
            canEdit={true}
            onSave={handleSavePermissions}
            onSearchUsers={handleSearchUsers}
            onGetUserMetadata={handleGetUserMetadata}
            onListGroups={handleListGroups}
            onClose={() => setPermissionManagerOpen(false)}
          />
        </Drawer>

        {/* Collection Editor Modal */}
        <CollectionEditor
          isOpen={collectionEditorOpen}
          editingCollection={editingCollection}
          parentPath={collectionEditorParentPath}
          availableSchemas={availableSchemas}
          onSave={handleCollectionSave}
          onAddEntryType={editingCollection ? (path, entryType) => addEntryType(path, entryType) : undefined}
          onUpdateEntryType={editingCollection ? (path, name, updates) => updateEntryType(path, name, updates) : undefined}
          onRemoveEntryType={editingCollection ? (path, name) => removeEntryType(path, name) : undefined}
          onClose={handleCloseCollectionEditor}
          isSaving={schemaLoading}
          error={collectionEditorError}
        />
      </Box>
    </CanopyCMSProvider>
  )
}

export default Editor
