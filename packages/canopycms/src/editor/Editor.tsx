'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { ActionIcon, Box, Button, Drawer, Group, Menu, Paper, Stack, Text, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { MdFolderOpen, MdAccountCircle, MdLogout, MdKeyboardArrowDown, MdSettings } from 'react-icons/md'
import { GoGitBranch } from 'react-icons/go'
import { PiColumnsDuotone, PiRowsDuotone } from 'react-icons/pi'
import { LuSquareDashed } from 'react-icons/lu'

import type { ContentFormat, FieldConfig, PathPermission } from '../config'
import { EntryNavigator, type EntryNavCollection } from './EntryNavigator'
import type { FormValue } from './FormRenderer'
import type { InternalGroup } from '../groups-file'
import { FormRenderer } from './FormRenderer'
import { PreviewFrame } from './preview-bridge'
import { normalizeCanopyPath } from './canopy-path'
import type { ApiResponse } from '../api/types'
import type { BranchState } from '../types'
import type { BranchMode } from '../paths'
import { EditorPanes, type PaneLayout } from './EditorPanes'
import { CanopyCMSProvider, type CanopyThemeOptions } from './theme'
import { BranchManager } from './BranchManager'
import { CommentsPanel } from './CommentsPanel'
import { GroupManager } from './GroupManager'
import { PermissionManager } from './PermissionManager'
import type { CommentThread } from '../comment-store'
import { buildPreviewSrc } from './editor-utils'
import { useEditorLayout, useEntryManager, useGroupManager, usePermissionManager } from './hooks'

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
}) => {
  const [branchNameState, setBranchNameState] = useState<string>(branchName)
  const [branches, setBranches] = useState<BranchState[]>([])
  const [drafts, setDrafts] = useState<Record<string, FormValue>>(() => initialValues ?? {})
  const [loadedValues, setLoadedValues] = useState<Record<string, FormValue>>({})
  const [busy, setBusy] = useState(false)
  const [branchManagerOpen, setBranchManagerOpen] = useState(false)
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false)
  const [comments, setComments] = useState<CommentThread[]>([])
  const [focusedFieldPath, setFocusedFieldPath] = useState<string | undefined>(undefined)
  const [highlightThreadId, setHighlightThreadId] = useState<string | undefined>(undefined)
  const [commentThreadPanelOpen, setCommentThreadPanelOpen] = useState(false)
  const [activeCommentContext, setActiveCommentContext] = useState<{
    type: 'field' | 'entry' | 'branch'
    canopyPath?: string
  } | null>(null)
  const [groupManagerOpen, setGroupManagerOpen] = useState(false)
  const [permissionManagerOpen, setPermissionManagerOpen] = useState(false)

  // Use custom hooks for layout, entry, group, and permission management
  const { layout, setLayout, highlightEnabled, setHighlightEnabled, headerRef, headerHeight } = useEditorLayout()
  const resolvePreviewSrc = useCallback(
    (entry: { collectionId?: string; collectionName?: string; slug?: string; type?: string; previewSrc?: string }) =>
      buildPreviewSrc(entry, { branchName: branchNameState, previewBaseByCollection }),
    [branchNameState, previewBaseByCollection]
  )
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
    collectionById,
  } = useEntryManager({
    initialEntries: entries,
    initialSelectedId,
    branchName: branchNameState,
    collections,
    previewBaseByCollection,
    resolvePreviewSrc,
    setBusy,
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

  const storageKey = useMemo(() => `canopycms:drafts:${branchNameState}`, [branchNameState])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!branchNameState) return
    const url = new URL(window.location.href)
    const current = url.searchParams.get('branch')
    if (current !== branchNameState) {
      url.searchParams.set('branch', branchNameState)
      window.history.replaceState({}, '', url.toString())
    }
  }, [branchNameState])

  const selectedValue = drafts[selectedId]
  const loadedValue = loadedValues[selectedId]
  const effectiveValue = selectedValue ?? loadedValue
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
  const currentBranch = branches.find((b) => b.branch.name === branchNameState)
  const branchStatus = currentBranch?.branch.status ?? 'editing'
  const schema = currentEntry?.schema ?? []
  const previewKey = currentEntry?.previewSrc ?? currentEntry?.id
  const modifiedCount = useMemo(() => Object.keys(drafts).length, [drafts])
  const editedFiles = useMemo(() => {
    const draftIds = Object.keys(drafts)
    if (draftIds.length === 0) return []
    return draftIds
      .map((id) => {
        const entry = entriesState.find((e) => e.id === id)
        return entry ? { id, label: entry.label } : null
      })
      .filter(Boolean) as { id: string; label: string }[]
  }, [drafts, entriesState])

  // Compute active comment threads for the thread panel
  const activeThreads = useMemo(() => {
    if (!activeCommentContext) return []

    if (activeCommentContext.type === 'field' && activeCommentContext.canopyPath) {
      return comments.filter(
        (t) =>
          t.type === 'field' &&
          t.entryId === selectedId &&
          t.canopyPath === activeCommentContext.canopyPath
      )
    } else if (activeCommentContext.type === 'entry') {
      return comments.filter((t) => t.type === 'entry' && t.entryId === selectedId)
    } else if (activeCommentContext.type === 'branch') {
      return comments.filter((t) => t.type === 'branch')
    }

    return []
  }, [activeCommentContext, comments, selectedId])

  const activeContextLabel = useMemo(() => {
    if (!activeCommentContext) return ''

    if (activeCommentContext.type === 'field' && activeCommentContext.canopyPath) {
      return activeCommentContext.canopyPath
    } else if (activeCommentContext.type === 'entry') {
      return selectedId
    } else if (activeCommentContext.type === 'branch') {
      return branchNameState
    }

    return ''
  }, [activeCommentContext, selectedId, branchNameState])

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

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(drafts))
    } catch (err) {
      console.warn('Failed to persist drafts', err)
    }
  }, [drafts, storageKey])

  const loadBranches = async (options?: { refreshEntries?: boolean }) => {
    setBusy(true)
    try {
      const res = await fetch('/api/canopycms/branches')
      if (res.status === 404) {
        // No branch endpoint available; stay branchless until user selects/creates via other means.
        setBranches([])
        return
      }
      if (!res.ok) throw new Error(`Failed to load branches: ${res.status}`)
      const payload = (await res.json()) as ApiResponse<{ branches: BranchState[] }>
      const list = ('data' in payload ? payload.data?.branches : (payload as any).branches) ?? []
      setBranches(list)
      const shouldRefresh = options?.refreshEntries ?? false
      if (shouldRefresh && branchNameState) {
        await refreshEntries(branchNameState)
      }
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Failed to load branches', color: 'red' })
    } finally {
      setBusy(false)
    }
  }

  const loadComments = async (branch: string) => {
    if (!branch) return
    try {
      const res = await fetch(`/api/canopycms/${branch}/comments`)
      if (!res.ok) {
        console.error('Failed to load comments:', res.status)
        return
      }
      const payload = (await res.json()) as ApiResponse<{ threads: CommentThread[] }>
      const threads = payload.data?.threads ?? []
      setComments(threads)
    } catch (err) {
      console.error('Failed to load comments:', err)
    }
  }

  const handleBranchChange = async (next: string | null) => {
    if (!next || next === branchNameState) return

    // Check for unsaved changes in the current entry
    if (selectedId && drafts[selectedId]) {
      // Consider it dirty if there's no loaded value (never saved) OR if draft differs from loaded
      const isDirty = !loadedValues[selectedId] ||
        JSON.stringify(drafts[selectedId]) !== JSON.stringify(loadedValues[selectedId])

      if (isDirty) {
        // Show confirmation modal
        return new Promise<void>((resolve, reject) => {
          modals.openConfirmModal({
            title: 'Unsaved Changes',
            children: (
              <Text size="sm">
                You have unsaved changes in the current entry. If you switch branches, your changes will be preserved on this browser, but won't be saved to the branch unless you explicitly click save.
              </Text>
            ),
            labels: { confirm: 'Switch Anyway', cancel: 'Stay' },
            confirmProps: { color: 'red' },
            onCancel: () => reject(new Error('User cancelled branch switch')),
            onConfirm: async () => {
              await performBranchSwitch(next)
              resolve()
            },
          })
        })
      }
    }

    await performBranchSwitch(next)
  }

  const performBranchSwitch = async (next: string) => {
    setBranchNameState(next)
    setDrafts({})
    setLoadedValues({})
    setSelectedId('')
    setEntriesState([])
    try {
      setBusy(true)
      await refreshEntries(next)
      await loadComments(next)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.set('branch', next)
        window.history.replaceState({}, '', url.toString())
      }
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Failed to load entries for branch', color: 'red' })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    loadBranches({ refreshEntries: Boolean(branchNameState) }).catch((err) => {
      console.error(err)
    })
    if (branchNameState) {
      loadComments(branchNameState).catch((err) => {
        console.error(err)
      })
    }
  }, [branchNameState, entries.length])

  useEffect(() => {
    const load = async () => {
      if (!currentEntry || drafts[selectedId]) return
      setBusy(true)
      try {
        const loaded = await loadEntry(currentEntry)
        setLoadedValues((prev) => ({ ...prev, [selectedId]: loaded }))
        setDrafts((prev) => ({ ...prev, [selectedId]: loaded }))
      } catch (err) {
        console.error(err)
        notifications.show({ message: 'Failed to load entry', color: 'red' })
      } finally {
        setBusy(false)
      }
    }
    load().catch((err) => {
      console.error(err)
      setBusy(false)
      notifications.show({ message: 'Failed to load entry', color: 'red' })
    })
  }, [currentEntry, drafts, selectedId])

  useEffect(() => {
    const handleFocus = (event: MessageEvent) => {
      const msg = event.data as { type?: string; entryId?: string; fieldPath?: string }
      if (msg?.type !== 'canopycms:preview:focus') return
      if (msg.entryId && msg.entryId !== (currentEntry?.previewSrc ?? currentEntry?.id)) return
      const normalizedPath = msg.fieldPath ? normalizeCanopyPath(msg.fieldPath) : undefined
      const target = normalizedPath
        ? document.querySelector<HTMLElement>(`[data-canopy-field="${normalizedPath}"]`)
        : null
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const previous = target.style.boxShadow
        target.style.boxShadow = '0 0 0 3px rgba(79, 70, 229, 0.35)'
        window.setTimeout(() => {
          target.style.boxShadow = previous
        }, 1200)

        // Set focused field path to trigger FieldWrapper auto-focus
        if (normalizedPath) {
          setFocusedFieldPath(normalizedPath)
          // Clear after brief delay to allow FieldWrapper to detect the change
          window.setTimeout(() => {
            setFocusedFieldPath(undefined)
          }, 100)
        }
      }
    }
    window.addEventListener('message', handleFocus)
    return () => window.removeEventListener('message', handleFocus)
  }, [currentEntry])

  const handleSave = async () => {
    if (!currentEntry || !effectiveValue) return
    setBusy(true)
    try {
      const saved = await saveEntry(currentEntry, effectiveValue)
      setDrafts((prev) => ({ ...prev, [selectedId]: saved }))
      setLoadedValues((prev) => ({ ...prev, [selectedId]: saved }))
      notifications.show({ message: 'Saved', color: 'green' })
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Save failed', color: 'red' })
    } finally {
      setBusy(false)
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
    notifications.show({ message: 'Drafts cleared', color: 'blue' })
  }

  const handleDiscardFileDraft = () => {
    if (!selectedId) return
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[selectedId]
      return next
    })
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem(storageKey)
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, FormValue>
          delete parsed[selectedId]
          window.localStorage.setItem(storageKey, JSON.stringify(parsed))
        }
      }
    } catch (err) {
      console.warn('Failed to clear draft for file', err)
    }
    notifications.show({ message: 'Draft cleared for file', color: 'blue' })
  }

  const handleReload = async () => {
    if (!currentEntry) return
    setBusy(true)
    try {
      const loaded = await loadEntry(currentEntry)
      setLoadedValues((prev) => ({ ...prev, [selectedId]: loaded }))
      setDrafts((prev) => ({ ...prev, [selectedId]: loaded }))
      notifications.show({ message: 'Reloaded', color: 'blue' })
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Reload failed', color: 'red' })
    } finally {
      setBusy(false)
    }
  }


  const handleReloadBranchData = async () => {
    await loadBranches({ refreshEntries: true })
  }

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

  const handleSubmit = async (branchName: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/canopycms/${branchName}/submit`, { method: 'POST' })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to submit branch')
      }
      notifications.show({ message: 'Branch submitted for review', color: 'green' })
      await loadBranches({ refreshEntries: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit branch'
      notifications.show({ message, color: 'red' })
    } finally {
      setBusy(false)
    }
  }

  const handleWithdraw = async (branchName: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/canopycms/${branchName}/withdraw`, { method: 'POST' })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to withdraw branch')
      }
      notifications.show({ message: 'Branch withdrawn', color: 'blue' })
      await loadBranches({ refreshEntries: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to withdraw branch'
      notifications.show({ message, color: 'red' })
    } finally {
      setBusy(false)
    }
  }

  const handleRequestChanges = async (branchName: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/canopycms/${branchName}/request-changes`, { method: 'POST' })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to request changes')
      }
      notifications.show({ message: 'Changes requested', color: 'orange' })
      await loadBranches({ refreshEntries: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request changes'
      notifications.show({ message, color: 'red' })
    } finally {
      setBusy(false)
    }
  }

  const handleAddComment = async (
    text: string,
    type: 'field' | 'entry' | 'branch',
    entryId?: string,
    canopyPath?: string,
    threadId?: string
  ) => {
    if (!branchNameState) return
    try {
      const body: any = { text, threadId, type }

      // Add entryId for field/entry comments
      if (entryId && (type === 'field' || type === 'entry')) {
        body.entryId = entryId
      }

      // Add canopyPath for field comments
      if (canopyPath && type === 'field') {
        body.canopyPath = canopyPath
      }

      const res = await fetch(`/api/canopycms/${branchNameState}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to add comment')
      await loadComments(branchNameState)
      await loadBranches({ refreshEntries: false })
      notifications.show({ message: 'Comment added', color: 'green' })
    } catch (err) {
      notifications.show({ message: 'Failed to add comment', color: 'red' })
    }
  }

  const handleResolveThread = async (threadId: string) => {
    if (!branchNameState) return
    try {
      const res = await fetch(`/api/canopycms/${branchNameState}/comments/${threadId}/resolve`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Failed to resolve thread')
      await loadComments(branchNameState)
      await loadBranches({ refreshEntries: false })
      notifications.show({ message: 'Thread resolved', color: 'green' })
    } catch (err) {
      notifications.show({ message: 'Failed to resolve thread', color: 'red' })
    }
  }

  const handleCreateBranch = async (branch: { name: string; title?: string; description?: string }) => {
    setBusy(true)
    try {
      const res = await fetch('/api/canopycms/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: branch.name, title: branch.title, description: branch.description }),
      })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to create branch')
      }
      notifications.show({ message: `Branch "${branch.name}" created`, color: 'green' })
      await loadBranches({ refreshEntries: false })
      // Switch to the newly created branch
      await handleBranchChange(branch.name)
      setBranchManagerOpen(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create branch'
      notifications.show({ message, color: 'red' })
    } finally {
      setBusy(false)
    }
  }

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
        <Paper
          ref={headerRef}
          withBorder
          radius={0}
          shadow="sm"
          px={0}
          py={0}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 70,
          }}
        >
          <Box px="md" py="sm">
            <Group justify="space-between" align="center" wrap="nowrap">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Title order={5} style={{ lineHeight: 1.1 }}>
                  {siteTitle}
                </Title>
                {siteSubtitle && (
                  <Text size="xs" c="dimmed">
                    {siteSubtitle}
                  </Text>
                )}
              </Stack>
              <Stack gap={6} style={{ minWidth: 0, flex: 1, alignItems: 'center' }}>
                <Title order={4} style={{ lineHeight: 1.1 }}>
                  {headerTitle}
                </Title>
                <Group gap="sm" wrap="wrap" align="center" style={{ minWidth: 0, justifyContent: 'center' }}>
                  <Menu withinPortal shadow="sm">
                    <Menu.Target>
                      <Button
                        variant="outline"
                        color="gray"
                        size="xs"
                        leftSection={<MdFolderOpen size={16} />}
                        rightSection={<MdKeyboardArrowDown size={14} />}
                      >
                        {currentEntry?.label ?? 'No file selected'}
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={handleReload} disabled={!branchNameState || !currentEntry}>
                        Reload File
                      </Menu.Item>
                      <Menu.Item onClick={handleDiscardFileDraft} disabled={!selectedId}>
                        Discard File Draft
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item onClick={() => setNavigatorOpen(true)}>All Files</Menu.Item>
                      <Menu.Divider />
                      <Menu.Item disabled>{'TODO: replace with real modified file list'}</Menu.Item>
                      <Menu.Divider />
                      <Menu.Label>Recently modified</Menu.Label>
                      {editedFiles.slice(0, 3).length === 0 ? (
                        <Menu.Item disabled>&lt;none&gt;</Menu.Item>
                      ) : (
                        editedFiles.slice(0, 3).map((file) => (
                          <Menu.Item
                            key={file.id}
                            onClick={() => {
                              setSelectedId(file.id)
                              setNavigatorOpen(false)
                            }}
                          >
                            {file.label}
                          </Menu.Item>
                        ))
                      )}
                    </Menu.Dropdown>
                  </Menu>

                  <Group gap={4} wrap="wrap" align="center" style={{ minWidth: 0 }}>
                    {breadcrumbSegments.map((segment, idx) => (
                      <Group key={`${segment}-${idx}`} gap={4} align="center" wrap="nowrap">
                        {idx > 0 && (
                          <Text size="xs" c="dimmed">
                            /
                          </Text>
                        )}
                        <Button variant="subtle" size="xs" px="xs" onClick={() => setNavigatorOpen(true)}>
                          {segment}
                        </Button>
                      </Group>
                    ))}
                  </Group>

                  <Menu withinPortal shadow="sm">
                    <Menu.Target>
                      <Button
                        variant="outline"
                        color="gray"
                        size="xs"
                        leftSection={<GoGitBranch size={16} />}
                        rightSection={<MdKeyboardArrowDown size={14} />}
                        disabled={!branchNameState}
                      >
                        {branchNameState || 'No branch selected'}
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={handleReloadBranchData} disabled={!branchNameState}>
                        Reload All Files
                      </Menu.Item>
                      <Menu.Item onClick={handleDiscardDrafts} disabled={!branchNameState}>
                        Discard All File Drafts
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item onClick={() => setBranchManagerOpen(true)}>Change / Manage Branches</Menu.Item>
                      <Menu.Divider />
                      <Menu.Label>{`${modifiedCount} files modified`}</Menu.Label>
                      {editedFiles.length === 0 ? (
                        <Menu.Item disabled>No edited files yet</Menu.Item>
                      ) : (
                        editedFiles.map((file) => (
                          <Menu.Item
                            key={`branch-mod-${file.id}`}
                            onClick={() => {
                              setSelectedId(file.id)
                              setNavigatorOpen(false)
                            }}
                          >
                            {file.label}
                          </Menu.Item>
                        ))
                      )}
                      <Menu.Divider />
                      <Menu.Item disabled>{'TODO: replace with real modified file list'}</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>

                  {branchMode !== 'local-simple' && branchNameState && (
                    <Button
                      variant="outline"
                      color="gray"
                      size="xs"
                      onClick={() => setCommentsPanelOpen(true)}
                      style={{ position: 'relative' }}
                    >
                      Comments
                      {comments.filter(t => !t.resolved).length > 0 && (
                        <span
                          style={{
                            position: 'absolute',
                            top: -6,
                            right: -6,
                            background: 'var(--mantine-color-grape-6)',
                            color: 'white',
                            borderRadius: '50%',
                            width: 18,
                            height: 18,
                            fontSize: 10,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 600,
                          }}
                        >
                          {comments.filter(t => !t.resolved).length}
                        </span>
                      )}
                    </Button>
                  )}
                </Group>
              </Stack>
              <Group gap="xs" wrap="nowrap">
                <Button
                  variant="light"
                  size="sm"
                  onClick={handleSave}
                  disabled={!branchNameState || !currentEntry || busy}
                >
                  Save File
                </Button>
                <Button
                  size="sm"
                  color="brand"
                  onClick={() => branchNameState && handleSubmit(branchNameState)}
                  disabled={!branchNameState || busy}
                >
                  Publish Branch
                </Button>
              </Group>
            </Group>
          </Box>
        </Paper>

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
            <Paper
              withBorder
              shadow="sm"
              radius={0}
              style={{
                position: 'fixed',
                top: headerHeight,
                bottom: footerHeight,
                right: 0,
                width: sidebarWidth,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 6px',
                gap: 8,
              }}
            >
              <Stack gap="sm" align="center" style={{ width: '100%', paddingTop: 6 }}>
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  radius="md"
                  aria-label="Toggle layout"
                  onClick={() => setLayout(layout === 'side' ? 'stacked' : 'side')}
                >
                  {layout === 'side' ? <PiRowsDuotone size={18} /> : <PiColumnsDuotone size={18} />}
                </ActionIcon>

                <ActionIcon
                  variant={highlightEnabled ? 'filled' : 'subtle'}
                  color={highlightEnabled ? 'brand' : 'gray'}
                  size="lg"
                  radius="md"
                  aria-pressed={highlightEnabled}
                  aria-label="Toggle highlights"
                  onClick={() => setHighlightEnabled(!highlightEnabled)}
                >
                  <LuSquareDashed size={18} />
                </ActionIcon>
              </Stack>
              <Stack gap="xs" align="center">
                <Menu shadow="md" width={200} position="left">
                  <Menu.Target>
                    <ActionIcon variant="subtle" size="lg" radius="md" aria-label="Settings">
                      <MdSettings size={18} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Settings</Menu.Label>
                    <Menu.Item onClick={() => setPermissionManagerOpen(true)}>
                      Manage Permissions
                    </Menu.Item>
                    <Menu.Item onClick={() => setGroupManagerOpen(true)}>
                      Manage Groups
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
                <ActionIcon variant="subtle" size="lg" radius="md" aria-label="Account">
                  <MdAccountCircle size={18} />
                </ActionIcon>
                <ActionIcon variant="subtle" size="lg" radius="md" aria-label="Sign out">
                  <MdLogout size={18} />
                </ActionIcon>
              </Stack>
            </Paper>
          </Box>
        </Box>

        <Paper
          withBorder
          radius={0}
          shadow="sm"
          px="md"
          py="xs"
          style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40 }}
        >
          <Group gap="md" justify="center">
            <Text size="xs" c="dimmed">
              Terms
            </Text>
            <Text size="xs" c="dimmed">
              Privacy
            </Text>
            <Text size="xs" c="dimmed">
              © CanopyCMS
            </Text>
          </Group>
        </Paper>

        <Drawer
          opened={navigatorOpen}
          onClose={() => setNavigatorOpen(false)}
          position="left"
          title="Content"
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
            title="Content"
          />
        </Drawer>
        <Drawer
          opened={branchManagerOpen}
          onClose={() => setBranchManagerOpen(false)}
          position="right"
          title="Branches"
          padding="md"
          size={420}
          overlayProps={{ blur: 2 }}
        >
          <BranchManager
            branches={branches.map((b) => {
              const branchComments = b.branch.name === branchNameState ? comments : []
              const unresolvedCount = branchComments.filter(t => !t.resolved).length
              return {
                name: b.branch.name,
                status: b.branch.status,
                createdBy: b.branch.createdBy,
                updatedAt: b.branch.updatedAt,
                access: {
                  users: b.branch.access.allowedUsers,
                  groups: b.branch.access.allowedGroups,
                },
                pullRequestUrl: b.pullRequestUrl,
                pullRequestNumber: b.pullRequestNumber,
                commentCount: unresolvedCount,
              }
            })}
            mode={branchMode}
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
            onJumpToField={(entryId, canopyPath, threadId) => {
              // Switch to the correct entry if needed
              if (entryId !== selectedId) {
                setSelectedId(entryId)
              }

              // Wait for entry to load, then scroll and highlight
              window.setTimeout(() => {
                // Find and scroll to the field element
                const fieldElement = document.querySelector(`[data-canopy-field="${canopyPath}"]`)
                if (fieldElement) {
                  fieldElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
                // Set focused field path and highlight thread
                setFocusedFieldPath(canopyPath)
                setHighlightThreadId(threadId)
                window.setTimeout(() => {
                  setFocusedFieldPath(undefined)
                  setHighlightThreadId(undefined)
                }, 2100) // Clear after highlight animation completes
              }, entryId !== selectedId ? 300 : 0) // Delay if switching entries
            }}
            onJumpToEntry={(entryId, threadId) => {
              // Switch to the correct entry if needed
              if (entryId !== selectedId) {
                setSelectedId(entryId)
              }

              // Wait for entry to load, then scroll and highlight
              window.setTimeout(() => {
                // Scroll to top of form (where EntryComments renders)
                const formElement = document.querySelector('[data-form-renderer]')
                if (formElement) {
                  formElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                // Set highlight thread
                setHighlightThreadId(threadId)
                window.setTimeout(() => {
                  setHighlightThreadId(undefined)
                }, 2100) // Clear after highlight animation completes
              }, entryId !== selectedId ? 300 : 0) // Delay if switching entries
            }}
            onJumpToBranch={(threadId) => {
              // Open branch manager and highlight thread
              setBranchManagerOpen(true)
              setHighlightThreadId(threadId)
              window.setTimeout(() => {
                setHighlightThreadId(undefined)
              }, 2100) // Clear after highlight animation completes
            }}
          />
        )}

        {/* Group Manager Modal */}
        <Drawer
          opened={groupManagerOpen}
          onClose={() => setGroupManagerOpen(false)}
          position="right"
          title="Manage Groups"
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
          title="Manage Permissions"
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
