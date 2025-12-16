'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ActionIcon,
  Box,
  Button,
  Drawer,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { MdFolderOpen, MdAccountCircle, MdLogout, MdKeyboardArrowDown } from 'react-icons/md'
import { GoGitBranch } from 'react-icons/go'
import { PiColumnsDuotone, PiRowsDuotone } from 'react-icons/pi'
import { LuSquareDashed } from 'react-icons/lu'

import type { ContentFormat, FieldConfig } from '../config'
import { EntryNavigator, type EntryNavCollection } from './EntryNavigator'
import type { FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { PreviewFrame } from './preview-bridge'
import { normalizeCanopyPath } from './canopy-path'
import type { ApiResponse } from '../api/types'
import type { ListEntriesResponse } from '../api/entries'
import type { BranchState } from '../types'
import type { BranchMode } from '../paths'
import { EditorPanes, type PaneLayout } from './EditorPanes'
import { CanopyCMSProvider, type CanopyThemeOptions } from './theme'
import { BranchManager } from './BranchManager'
import {
  buildEntriesFromListResponse,
  buildPreviewSrc,
  buildWritePayload,
  normalizeContentPayload,
} from './editor-utils'

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
}) => {
  const [branchNameState, setBranchNameState] = useState<string>(branchName)
  const [branches, setBranches] = useState<BranchState[]>([])
  const [entriesState, setEntriesState] = useState<EditorEntry[]>(entries)
  const [selectedId, setSelectedId] = useState<string>(
    initialSelectedId ?? entriesState[0]?.id ?? '',
  )
  const [drafts, setDrafts] = useState<Record<string, FormValue>>(() => initialValues ?? {})
  const [loadedValues, setLoadedValues] = useState<Record<string, FormValue>>({})
  const [busy, setBusy] = useState(false)
  const [highlightEnabled, setHighlightEnabled] = useState(false)
  const [navigatorOpen, setNavigatorOpen] = useState(false)
  const [branchManagerOpen, setBranchManagerOpen] = useState(false)
  const [layout, setLayout] = useState<PaneLayout>('side')
  const headerRef = useRef<HTMLDivElement | null>(null)
  const [headerHeight, setHeaderHeight] = useState<number>(80)

  const storageKey = useMemo(() => `canopycms:drafts:${branchNameState}`, [branchNameState])

  const resolvePreviewSrc = useCallback(
    (entry: {
      collectionId?: string
      collectionName?: string
      slug?: string
      type?: string
      previewSrc?: string
    }) => buildPreviewSrc(entry, { branchName: branchNameState, previewBaseByCollection }),
    [branchNameState, previewBaseByCollection],
  )

  useEffect(() => {
    const normalizedEntries =
      entries?.map((entry) =>
        entry.previewSrc ? entry : { ...entry, previewSrc: resolvePreviewSrc(entry) },
      ) ?? []
    setEntriesState(normalizedEntries)
  }, [entries, resolvePreviewSrc])

  useEffect(() => {
    if (!entriesState.find((e) => e.id === selectedId)) {
      setSelectedId(entriesState[0]?.id ?? '')
    }
  }, [entriesState, selectedId])

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

  const currentEntry = useMemo(
    () => entriesState.find((e) => e.id === selectedId),
    [entriesState, selectedId],
  )
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
  const collectionById = useMemo(() => {
    const map = new Map<string, EditorCollection>()
    flattenedCollections.forEach((c) => map.set(c.id, c))
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

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const entryParam = params.get('entry')
    if (entryParam && entriesState.find((e) => e.id === entryParam)) {
      setSelectedId(entryParam)
    }
  }, [entriesState])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (selectedId) {
      url.searchParams.set('entry', selectedId)
    } else {
      url.searchParams.delete('entry')
    }
    window.history.replaceState({}, '', url.toString())
  }, [selectedId])

  const loadEntry = async (entry: EditorEntry) => {
    const res = await fetch(entry.apiPath)
    if (!res.ok) throw new Error(`Load failed: ${res.status}`)
    const payload = (await res.json()) as ApiResponse
    const content = 'data' in payload ? (payload as ApiResponse).data : payload
    return normalizeContentPayload(content)
  }

  const saveEntry = async (entry: EditorEntry, value: FormValue) => {
    const res = await fetch(entry.apiPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWritePayload(entry, value)),
    })
    if (!res.ok) throw new Error(`Save failed: ${res.status}`)
    const payload = (await res.json()) as ApiResponse
    const content = 'data' in payload ? (payload as ApiResponse).data : payload
    return normalizeContentPayload(content)
  }

  const refreshEntries = async (branch: string = branchNameState) => {
    if (!branch) return
    const res = await fetch(`/api/canopycms/${branch}/entries`)
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`)
    const payload = (await res.json()) as ApiResponse<ListEntriesResponse>
    const data = ('data' in payload ? payload.data : payload) as ListEntriesResponse
    const refreshed = buildEntriesFromListResponse({
      response: data,
      branchName: branch,
      resolvePreviewSrc,
      existingEntries: entriesState,
      currentEntry,
      initialEntries: entries,
    })
    setEntriesState(refreshed)
    const newlyCreated = refreshed.find((e) => !entriesState.find((old) => old.id === e.id))
    if (newlyCreated) {
      setSelectedId(newlyCreated.id)
    }
  }

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

  const handleBranchChange = async (next: string | null) => {
    if (!next || next === branchNameState) return
    setBranchNameState(next)
    setDrafts({})
    setLoadedValues({})
    setSelectedId('')
    setEntriesState([])
    try {
      setBusy(true)
      await refreshEntries(next)
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
  }, [branchNameState, entries.length])

  useEffect(() => {
    if (!headerRef.current) return
    const node = headerRef.current
    const updateHeight = () => setHeaderHeight(node.getBoundingClientRect().height || 80)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

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

  const handleCreateEntry = async (collectionId: string) => {
    const col = collectionById.get(collectionId)
    if (!col || col.type === 'singleton') return
    const slug = window.prompt(`New ${col.label ?? col.name} slug?`, 'untitled')
    if (!slug) return
    setBusy(true)
    try {
      const payload =
        col.format === 'json'
          ? { collection: collectionId, slug, format: 'json' as const, data: {} }
          : { collection: collectionId, slug, format: col.format, data: {}, body: '' }
      const res = await fetch(
        `/api/canopycms/${branchNameState}/content/${encodeURIComponent(collectionId)}/${encodeURIComponent(slug)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) throw new Error(`Create failed: ${res.status}`)
      await refreshEntries()
      notifications.show({ message: 'Created new entry', color: 'green' })
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Create failed', color: 'red' })
    } finally {
      setBusy(false)
    }
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

  const defaultPreview = currentEntry?.previewSrc ? (
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

  const handleSubmit = () =>
    notifications.show({ message: 'Submit flow not wired yet', color: 'blue' })
  const handleRequestChanges = () =>
    notifications.show({ message: 'Request changes flow not wired yet', color: 'blue' })

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
                <Group
                  gap="sm"
                  wrap="wrap"
                  align="center"
                  style={{ minWidth: 0, justifyContent: 'center' }}
                >
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
                      <Menu.Item
                        onClick={handleReload}
                        disabled={!branchNameState || !currentEntry}
                      >
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
                        <Button
                          variant="subtle"
                          size="xs"
                          px="xs"
                          onClick={() => setNavigatorOpen(true)}
                        >
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
                      <Menu.Item onClick={() => setBranchManagerOpen(true)}>
                        Change / Manage Branches
                      </Menu.Item>
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
                  onClick={handleSubmit}
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
                preview={
                  renderPreview && currentEntry
                    ? renderPreview(currentEntry, effectiveValue)
                    : defaultPreview
                }
                form={
                  schema.length > 0 ? (
                    <FormRenderer
                      fields={schema}
                      value={effectiveValue ?? {}}
                      onChange={(next) => setDrafts((prev) => ({ ...prev, [selectedId]: next }))}
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
                  onClick={() => setLayout((prev) => (prev === 'side' ? 'stacked' : 'side'))}
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
                  onClick={() => setHighlightEnabled((prev) => !prev)}
                >
                  <LuSquareDashed size={18} />
                </ActionIcon>
              </Stack>
              <Stack gap="xs" align="center">
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
            branches={branches.map((b) => ({
              name: b.branch.name,
              status: b.branch.status,
              createdBy: b.branch.createdBy,
              updatedAt: b.branch.updatedAt,
              access: {
                users: b.branch.access.allowedUsers,
                groups: b.branch.access.allowedGroups,
              },
            }))}
            mode={branchMode}
            onSelect={(name) => {
              handleBranchChange(name).catch((err) => console.error(err))
              setBranchManagerOpen(false)
            }}
            onClose={() => setBranchManagerOpen(false)}
          />
        </Drawer>
      </Box>
    </CanopyCMSProvider>
  )
}

export default Editor
