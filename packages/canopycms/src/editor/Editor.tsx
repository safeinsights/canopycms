'use client'

import React, { useEffect, useMemo, useState, useRef } from 'react'

import { ActionIcon, Box, Drawer, Group, Paper, Text, Title, useTree } from '@mantine/core'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'

// TreeController type from Mantine's useTree hook
type TreeController = ReturnType<typeof useTree>

import type { ContentFormat, FieldConfig, RootCollectionConfig } from '../config'
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
import {
  useEditorLayout,
  useDraftManager,
  useEntryManager,
  useGroupManager,
  usePermissionManager,
  useCommentSystem,
  useBranchManager,
  useUserContext,
} from './hooks'
import { useBranchActions } from './hooks/useBranchActions'
import { EditorFooter, EditorHeader, EditorSidebar } from './components'

export interface EditorEntry {
  id: string
  label: string
  status?: string
  schema: readonly FieldConfig[]
  apiPath: string
  previewSrc?: string
  collectionId?: string
  collectionName?: string
  slug?: string
  format?: ContentFormat
  type?: 'entry' | 'singleton'
  canEdit?: boolean
}

export interface EditorCollection {
  id: string
  name: string
  label?: string
  format: ContentFormat
  type: 'collection' | 'entry'
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
  configSchema?: RootCollectionConfig
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
  configSchema,
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

  // Preview data with resolved references for live preview
  const [previewData, setPreviewData] = useState<FormValue>({})
  const [previewLoadingState, setPreviewLoadingState] = useState<FormValue>({})

  // Fetch current user context for permission checks
  const { userContext } = useUserContext()

  // Use custom hooks for layout, entry, draft, group, permission, comment, and branch management
  const { layout, setLayout, highlightEnabled, setHighlightEnabled, headerRef, headerHeight } =
    useEditorLayout()

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

  // 2. Entry manager (depends on branchNameState, owns selectedId)
  const {
    selectedId,
    setSelectedId,
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
    resolvePreviewSrc: (entry) =>
      buildPreviewSrc(entry, { branchName: branchNameState, previewBaseByCollection }),
    setBusy: setEntriesLoading,
  })

  // Use collections from API (falls back to props if not loaded yet)
  const activeCollections = collectionsFromApi.length > 0 ? collectionsFromApi : collections

  // 3. Draft manager (depends on branchNameState, selectedId from useEntryManager)
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
    selectedId,
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
    selectedId,
    currentEntry,
    currentUser,
    canResolveComments,
    setSelectedId,
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

  const { permissionsData, permissionsLoading, handleSavePermissions, handleListGroups } =
    usePermissionManager({
      isOpen: permissionManagerOpen,
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
  const collectionLabels = useMemo(
    () => buildCollectionLabels(activeCollections),
    [activeCollections],
  )
  const schema = currentEntry?.schema ?? []
  const previewKey = currentEntry?.previewSrc ?? currentEntry?.id

  // Effect to load entry data when selection changes
  useEffect(() => {
    const load = async () => {
      if (!currentEntry || drafts[selectedId]) return
      setEntriesLoading(true)
      try {
        const loaded = await loadEntry(currentEntry)
        setLoadedValues((prev) => ({ ...prev, [selectedId]: loaded }))
        setDrafts((prev) => ({ ...prev, [selectedId]: loaded }))
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
  }, [currentEntry, drafts, selectedId])

  const navCollections = useMemo<EntryNavCollection[] | undefined>(() => {
    if (!activeCollections) return undefined
    const grouped = new Map<string, EntryNavCollection['entries']>()
    entriesState.forEach((entry) => {
      if (!entry.collectionId) return
      const list = grouped.get(entry.collectionId) ?? []
      list.push({ id: entry.id, label: entry.label, status: entry.status })
      grouped.set(entry.collectionId, list)
    })
    const build = (node: EditorCollection): EntryNavCollection => ({
      id: node.id,
      label: node.label ?? node.name,
      type: node.type,
      entries: grouped.get(node.id),
      children: node.children?.map((child) => build(child)),
      onAdd:
        node.type !== 'entry'
          ? () => (onCreateEntry ? onCreateEntry(node.id) : handleCreateEntry(node.id))
          : undefined,
    })
    return activeCollections.map((node) => build(node))
  }, [activeCollections, entriesState, onCreateEntry, handleCreateEntry])

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
    [collectionLabels, currentEntry],
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
          onEntrySelect={setSelectedId}
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
                preview={
                  renderPreview && currentEntry
                    ? renderPreview(currentEntry, effectiveValue)
                    : defaultPreview
                }
                form={
                  !currentEntry ? (
                    <CenteredMessage>Select an item to start editing.</CenteredMessage>
                  ) : currentEntry.canEdit === false ? (
                    <CenteredMessage>
                      You don't have permission to edit this content.
                    </CenteredMessage>
                  ) : schema.length > 0 && effectiveValue ? (
                    <FormRenderer
                      fields={schema}
                      value={effectiveValue}
                      onChange={(next) => setDrafts((prev) => ({ ...prev, [selectedId]: next }))}
                      branch={branchNameState}
                      onResolvedValueChange={setPreviewData}
                      onLoadingStateChange={setPreviewLoadingState}
                      comments={comments}
                      currentEntryId={selectedId}
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

        <Drawer.Root
          opened={navigatorOpen}
          onClose={() => setNavigatorOpen(false)}
          position="left"
          size={360}
        >
          <Drawer.Overlay blur={2} />
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title>Content</Drawer.Title>
              <Group gap="xs">
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
                      : entriesState.map((e) => ({ id: e.id, label: e.label, status: e.status }))
                  }
                  selectedId={selectedId}
                  onSelect={(id) => {
                    setSelectedId(id)
                    setNavigatorOpen(false)
                  }}
                  onTreeControllerReady={handleTreeControllerReady}
                  expandedStateRef={treeExpandedStateRef}
                  onExpandedStateChange={handleExpandedStateChange}
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
            schema={configSchema}
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
      </Box>
    </CanopyCMSProvider>
  )
}

export default Editor
