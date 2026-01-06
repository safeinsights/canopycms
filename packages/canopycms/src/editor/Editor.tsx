'use client'

import React, { useEffect, useMemo, useState } from 'react'

import { Box, Drawer, Paper, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'

import type { ContentFormat, FieldConfig } from '../config'
import { EntryNavigator, type EntryNavCollection } from './EntryNavigator'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { PreviewFrame } from './preview-bridge'
import type { BranchMode } from '../paths'
import { EditorPanes } from './EditorPanes'
import { CanopyCMSProvider, type CanopyThemeOptions } from './theme'
import { BranchManager } from './BranchManager'
import { CommentsPanel } from './CommentsPanel'
import { GroupManager } from './GroupManager'
import { PermissionManager } from './PermissionManager'
import type { CommentThread } from '../comment-store'
import { buildPreviewSrc } from './editor-utils'
import { useEditorLayout, useDraftManager, useEntryManager, useGroupManager, usePermissionManager, useCommentSystem, useBranchManager, useUserContext } from './hooks'
import { useBranchActions } from './hooks/useBranchActions'
import { EditorFooter, EditorHeader, EditorSidebar } from './components'

export interface EditorEntry {
  id: string
  label: string
  status?: string
  schema: FieldConfig[]
  apiPath: string
  previewSrc?: string
  collectionId?: string
  collectionName?: string
  slug?: string
  format?: ContentFormat
  type?: 'entry' | 'singleton'
}

export interface EditorCollection {
  id: string
  name: string
  label?: string
  format: ContentFormat
  type: 'collection' | 'singleton'
  children?: EditorCollection[]
}

export interface EditorProps {
  entries: EditorEntry[]
  title: string
  subtitle?: string
  siteTitle?: string
  siteSubtitle?: string
  branchName?: string
  branchMode?: BranchMode
  collections?: EditorCollection[]
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
  initialSelectedId,
  initialValues,
  renderPreview,
  onCreateEntry,
  themeOptions,
  branchMode = 'local-simple',
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
    handleSubmit,
    handleWithdraw,
    handleRequestChanges,
    handleReloadBranchData,
    loadBranches,
  } = useBranchManager({
    initialBranch: branchName,
    branchMode,
    setBusy: setBranchesLoading,
    comments: commentsForBranchSummaries,
  })

  // 2. Entry manager (depends on branchNameState, owns selectedId)
  const {
    selectedId,
    setSelectedId,
    entries: entriesState,
    setEntries: setEntriesState,
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
    resolvePreviewSrc: (entry) => buildPreviewSrc(entry, { branchName: branchNameState, previewBaseByCollection }),
    setBusy: setEntriesLoading,
  })

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
    handleSearchExternalGroups,
  } = useGroupManager({ isOpen: groupManagerOpen })

  const { permissionsData, permissionsLoading, handleSavePermissions, handleListGroups } = usePermissionManager({
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
    walk(collections)
    return all
  }, [collections])
  const collectionLabels = useMemo(() => {
    const map = new Map<string, string>()
    flattenedCollections.forEach((c) => map.set(c.id, c.label ?? c.name))
    return map
  }, [flattenedCollections])
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
    if (!collections) return undefined
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
        node.type !== 'singleton'
          ? () => (onCreateEntry ? onCreateEntry(node.id) : handleCreateEntry(node.id))
          : undefined,
    })
    return collections.map((node) => build(node))
  }, [collections, entriesState, onCreateEntry, handleCreateEntry])

  const defaultPreview =
    currentEntry?.previewSrc ? (
      <PreviewFrame
        src={currentEntry.previewSrc}
        path={currentEntry.previewSrc}
        data={effectiveValue}
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
  const breadcrumbSegments = useMemo(() => {
    if (!currentEntry) return ['All Files']
    const segments = ['All Files']
    if (currentEntry.type !== 'singleton' && currentEntry.collectionId) {
      segments.push(collectionLabels.get(currentEntry.collectionId) ?? currentEntry.collectionId)
    }
    const slugSegments = (currentEntry.slug ?? '').split('/').filter(Boolean)
    if (slugSegments.length > 1) {
      segments.push(...slugSegments.slice(0, -1))
    }
    return segments
  }, [collectionLabels, currentEntry])

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
          branchMode={branchMode}
          busy={busy}
          breadcrumbSegments={breadcrumbSegments}
          editedFiles={editedFiles}
          modifiedCount={modifiedCount}
          unresolvedCommentCount={comments.filter((t) => !t.resolved).length}
          comments={comments}
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
                  schema.length > 0 ? (
                    <FormRenderer
                      fields={schema}
                      value={effectiveValue ?? {}}
                      onChange={(next) => setDrafts((prev) => ({ ...prev, [selectedId]: next }))}
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
                    <Text size="sm" c="dimmed">
                      No fields to edit.
                    </Text>
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

        <Drawer
          opened={navigatorOpen}
          onClose={() => setNavigatorOpen(false)}
          position="left"
          title={
            <div>
              <Title order={4}>Content</Title>
            </div>
          }
          padding="md"
          size={360}
          overlayProps={{ blur: 2 }}
        >
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
          />
        </Drawer>
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
            mode={branchMode}
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
            schema={collections?.map(c => ({
              type: c.type,
              name: c.name,
              label: c.label,
              path: c.id,
              format: c.format,
              fields: [],
            })) ?? []}
            permissions={permissionsData}
            loading={permissionsLoading}
            canEdit={true}
            onSave={handleSavePermissions}
            onSearchUsers={handleSearchUsers}
            onListGroups={handleListGroups}
            onClose={() => setPermissionManagerOpen(false)}
          />
        </Drawer>
      </Box>
    </CanopyCMSProvider>
  )
}

export default Editor
