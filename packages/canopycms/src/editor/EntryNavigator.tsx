'use client'

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ContentId, LogicalPath } from '../paths/types'

import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  CloseButton,
  Code,
  Group,
  Highlight,
  Loader,
  Menu,
  Skeleton,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
  Tree,
  VisuallyHidden,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
  rem,
} from '@mantine/core'
import { useMergedRef } from '@mantine/hooks'
import {
  IconArrowDown,
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowRight,
  IconChevronRight,
  IconArrowUp,
  IconDots,
  IconEdit,
  IconFolderPlus,
  IconLock,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react'
import type { BranchChangesData, BranchChangeEntry } from '../api/branch-changes'
import type { BranchChangesError } from './hooks/useBranchChangesData'

import { calculatePathToEntry } from './editor-utils'
import { entryDetailLine, matchesEntryQuery } from './entry-search'
import { EDITOR_ACTIONS } from './copy'
import { humanizeName } from './schema-label'
import { DestructiveMenuItem } from './components/DestructiveMenuItem'
import { UnsavedMark } from './components/UnsavedMark'
import { BranchRowLock } from './components/BranchRowLock'
import { BranchNotAvailableNotice } from './components/BranchNotAvailableNotice'
import { ReasonedMenuItem } from './components/ReasonedMenuItem'
import { UnavailableTypeMessage } from './components/UnavailableTypeMessage'

type TreeController = ReturnType<typeof useTree>

const UnavailableTypeRow: React.FC<{ schemaRefs: readonly string[] }> = ({ schemaRefs }) => (
  <Group gap={6} wrap="nowrap" align="flex-start" mt={4} data-testid="unavailable-type-message">
    <Box c="orange" style={{ display: 'flex', flexShrink: 0, paddingTop: 2 }}>
      <IconAlertTriangle size={14} aria-hidden />
    </Box>
    <Text size="xs" c="orange">
      <UnavailableTypeMessage schemaRefs={schemaRefs} />
    </Text>
  </Group>
)

/** Where path rules refuse new entries, one line says so in place of the "…" menus they hide. */
const AddRefusedRow: React.FC = () => (
  <Text size="xs" c="dimmed" mt={4} data-testid="add-refused-message">
    You can&apos;t add entries here.
  </Text>
)

export interface EntryNavItem {
  path: LogicalPath
  label: string
  /** The entry's title, matched by the filter where the label is a singleton's type label. */
  title?: string
  /** Matched by the filter; the last segment of `path` when absent. */
  slug?: string
  /** The entry's type, or "Missing" (`entryStatusLabel`): its second line, with `route`. */
  status?: string
  /** The entry's route (`buildPreviewRoute`); its second line omits it when `noPage` or `missing`. */
  route?: string
  /** The entry's file is gone: its second line is error text. */
  missing?: boolean
  /** The entry has no page on the site, so its menu changes its slug rather than its URL. */
  noPage?: boolean
  collectionPath?: LogicalPath
  contentId?: ContentId // 12-char embedded ID for ordering
  /** True when this entry's file conflicted during rebase */
  conflictNotice?: boolean
  /** True when the entry's type is unavailable; it shows no menu, since every item in it writes. */
  unavailable?: boolean
  /** True when this user cannot edit the entry: it shows a lock and no menu, since every item writes. */
  readOnly?: boolean
}

export interface EntryNavCollection {
  path: LogicalPath
  label: string
  type: 'collection' | 'entry'
  contentId?: ContentId // 12-char embedded ID for ordering
  order?: readonly string[] // Order array for interleaving entries and children
  entries?: EntryNavItem[]
  children?: EntryNavCollection[]
  /** True when this collection's .collection.json conflicted during rebase */
  conflictNotice?: boolean
  /** Registry keys of this collection's unavailable entry types; non-empty shows the message once. */
  unavailableSchemaRefs?: readonly string[]
  /** True when this user's path rules refuse a new entry here: the collection says so once. */
  addRefused?: boolean
  onAdd?: () => void
  onEdit?: () => void
  onAddSubCollection?: () => void
  onDelete?: () => void
}

export interface EntryNavigatorProps {
  items?: EntryNavItem[]
  collections?: EntryNavCollection[]
  selectedPath?: string
  onSelect: (id: string) => void
  onTreeControllerReady?: (controller: TreeController) => void
  expandedStateRef?: React.MutableRefObject<Record<string, boolean>>
  onExpandedStateChange?: (state: Record<string, boolean>) => void
  /** Called when user requests to delete an entry */
  onDeleteEntry?: (path: LogicalPath) => void
  /** Called when the user asks to change an entry's URL (its slug) */
  onRenameEntry?: (path: LogicalPath) => void
  /** Called when user reorders an entry within a collection */
  onReorderEntry?: (
    collectionPath: LogicalPath,
    contentId: string,
    direction: 'up' | 'down',
  ) => void
  /** If provided, this collection path's node is hidden but its children are rendered at the top level */
  hiddenRootPath?: string
  /** When true and the tree is empty, show a loading indicator instead of "No content" */
  loading?: boolean
  /**
   * When true, replaces each row's mutation menu (create, rename, delete, reorder, add/edit
   * collection) with a lock -- selection/navigation stays enabled. Set on a branch that takes no
   * writes, where they would only 403 after the fact. An entry the user may not edit keeps its own
   * lock and gets none here. Default false.
   */
  readOnly?: boolean
  /**
   * Why the branch takes no writes (`describeBranchLock`), the tooltip of each row's lock. While
   * readOnly without one, the lock's slot stays empty.
   */
  readOnlyReason?: string
  /** Entry paths with unsaved changes; each shows a dot, and so does every collection holding one. */
  dirtyPaths?: ReadonlySet<string>
  /** A row to bring into view, or (`unsaved`) the unsaved entries; `onRevealed` once done. */
  reveal?: ContentPanelReveal
  /** The reveal is done, or its row is not in the tree. */
  onRevealed?: () => void
  /**
   * The All / Unsaved / Changed control shows only with this. Unsaved lists the entries in
   * `dirtyPaths`; Changed, those in `branchChanges`.
   */
  onEntryFilterChange?: (filter: EntryFilter) => void
  entryFilter?: EntryFilter
  /** What the branch changes against its base. Without it the control offers no Changed. */
  branchChanges?: BranchChangesView
  /** Lists the unsaved entries, as the top bar's count does; else Unsaved is chosen here. */
  onShowUnsaved?: () => void
  /** Entries with unsaved changes, counting drafts whose entries the tree doesn't list yet. */
  unsavedCount?: number
  /** The named unsaved entries; Unsaved offers any the tree has no row for beneath it. */
  unsavedEntries?: ReadonlyArray<{ path: string; label: string }>
  /** The branch's entry list failed to load, so Unsaved can't name what is unsaved. */
  entryListFailed?: boolean
  /** The bar's "Not available" row: an empty tree says so, with `onSwitchBranch`, not "No content". */
  branchNotAvailable?: boolean
  onSwitchBranch?: () => void
  /** Takes Enter's first match in the filter in place of `onSelect`. */
  onFilterEnter?: (path: string) => void
  /** Escape in the empty filter. Without it, Escape there does nothing here. */
  onFilterEscape?: () => void
  onRowMenuOpen?: () => void
  filterRef?: React.Ref<HTMLInputElement>
  /** The shortcut that focuses the filter, as the platform writes it ("⌘P") and for `aria-keyshortcuts`. */
  filterShortcut?: { label: string; keys: string }
}

/**
 * A collection or entry reveal clears the query, switches the filter back to All, expands the
 * row's ancestors (and a collection itself) and focuses the row. An `unsaved` reveal clears the
 * query only, for Unsaved set alongside it. `seq` makes a repeat ask a new one.
 */
export type ContentPanelReveal =
  | { kind: 'collection' | 'entry'; path: string; seq: number }
  | { kind: 'unsaved'; seq: number }

/** Which entries the Content panel lists: all, those with unsaved edits, or those differing from the base. */
export type EntryFilter = 'all' | 'unsaved' | 'changed'

/** The branch's changes against its base, as the Changed filter shows them. */
export interface BranchChangesView {
  /** The base branch's name, for the copy. */
  base: string
  /** The last answer, kept while a reload or its error shows. */
  data?: BranchChangesData
  error?: BranchChangesError
  onRetry: () => void
  /** A reload is in flight, so Retry shows it is working. */
  retrying?: boolean
}

type ChangeMarkerKind = BranchChangeEntry['status'] | 'settings'

const CHANGE_MARKERS: Record<ChangeMarkerKind, { label: string; icon: React.ReactNode }> = {
  added: { label: 'New', icon: <IconPlus size={10} aria-hidden /> },
  modified: { label: 'Edited', icon: <IconPencil size={10} aria-hidden /> },
  moved: { label: 'Moved', icon: <IconArrowRight size={10} aria-hidden /> },
  deleted: { label: 'Deleted', icon: <IconTrash size={10} aria-hidden /> },
  settings: { label: 'Settings edited', icon: <IconSettings size={10} aria-hidden /> },
}

/**
 * A row's change against the base: a word and an icon, never colour alone. Its visually hidden
 * words join the row's accessible name: " on this branch", " from <where>" for a move, none
 * where a heading already says it (`context: null`).
 */
const ChangeMarker: React.FC<{ kind: ChangeMarkerKind; context?: string | null }> = ({
  kind,
  context = ' on this branch',
}) => (
  <Badge
    size="xs"
    variant="light"
    color="gray"
    leftSection={CHANGE_MARKERS[kind].icon}
    data-testid={`change-marker-${kind}`}
    style={{ flexShrink: 0 }}
  >
    {kind === 'settings' ? (
      <>
        <span aria-hidden>{CHANGE_MARKERS.settings.label}</span>
        <VisuallyHidden component="span">Settings changed on this branch</VisuallyHidden>
      </>
    ) : (
      <>
        {CHANGE_MARKERS[kind].label}
        {context && <VisuallyHidden component="span">{context}</VisuallyHidden>}
      </>
    )}
  </Badge>
)

/** A segment's count, capped so the control keeps its width. */
const segmentCount = (count: number) => (count > 99 ? '99+' : String(count))

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const lastSegment = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** A collection's node value; a single-entry collection's node is its entry. */
const collectionNodeValue = (nodes: TreeNodeData[], path: string): string | undefined => {
  for (const node of nodes) {
    if (node.value === `collection:${path}` || node.nodeProps?.collectionPath === path) {
      return node.value
    }
    const inner = node.children && collectionNodeValue(node.children, path)
    if (inner) return inner
  }
  return undefined
}

/** The collection values below `nodes` that have children, as an all-expanded state. */
const expandedStateFor = (nodes: TreeNodeData[], acc: Record<string, boolean> = {}) => {
  for (const node of nodes) {
    if (node.children?.length) {
      acc[node.value] = true
      expandedStateFor(node.children, acc)
    }
  }
  return acc
}

/**
 * The nodes of `nodes` that match `query` and, given `changed`, are in it. An entry matches on
 * label, title or slug; a collection whose label matches keeps its whole subtree, or under `changed` its
 * changed entries, and any other collection survives only with its matching descendants or, when
 * `changed` holds the collection itself, a matching label. Nodes keep the position data
 * (`childIndex`, `totalChildrenCount`) of the full tree.
 */
const filterTree = (
  nodes: TreeNodeData[],
  query: string,
  changed?: ReadonlySet<string>,
): TreeNodeData[] => {
  const kept: TreeNodeData[] = []
  for (const node of nodes) {
    const label = String(node.label ?? '')
    if (node.nodeProps?.isEntry) {
      const { slug, title } = node.nodeProps as { slug?: string; title?: string }
      if (
        matchesEntryQuery({ label, title, slug }, query) &&
        (!changed || changed.has(node.value))
      ) {
        kept.push(node)
      }
      continue
    }
    // An empty query matches every label, so under Changed a collection is never kept whole.
    const labelMatches = matchesEntryQuery({ label }, query)
    if (labelMatches && !changed) {
      kept.push(node)
      continue
    }
    const children = filterTree(node.children ?? [], labelMatches ? '' : query, changed)
    if (children.length > 0 || (labelMatches && changed?.has(node.value))) {
      kept.push({ ...node, children })
    }
  }
  return kept
}

/** Whether `value` is a node of `nodes`, at any depth. */
const hasNode = (nodes: TreeNodeData[], value: string): boolean =>
  nodes.some((node) => node.value === value || hasNode(node.children ?? [], value))

/** The first entry in tree order that matches `query`, else the first entry of any kind. */
const firstEntryPath = (nodes: TreeNodeData[], query: string): string | undefined => {
  const entries: TreeNodeData[] = []
  const walk = (list: TreeNodeData[]) => {
    for (const node of list) {
      if (node.nodeProps?.isEntry) entries.push(node)
      else walk(node.children ?? [])
    }
  }
  walk(nodes)
  const match = entries.find((node) =>
    matchesEntryQuery(
      {
        label: String(node.label ?? ''),
        title: node.nodeProps?.title as string | undefined,
        slug: node.nodeProps?.slug as string | undefined,
      },
      query,
    ),
  )
  return (match ?? entries[0])?.value
}

const TOOLTIP_DELAY = 400

/**
 * A line of a row, truncated with an ellipsis. Its full text shows in a tooltip on hover, and only
 * while the text is cut: the width is measured when the pointer or focus enters the row, not on
 * every render.
 */
const TruncatedLabel: React.FC<{
  label: string
  highlight?: string
  fw?: number
  size?: 'sm' | 'xs'
  c?: string
}> = ({ label, highlight = '', fw, size = 'sm', c }) => {
  const elementRef = useRef<HTMLElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  const setElement = useCallback((node: HTMLElement | null) => {
    elementRef.current = node
  }, [])

  useEffect(() => {
    const row = elementRef.current?.closest('[data-nav-row]')
    if (!row) return
    // Read at measure time: the label swaps between Text and Highlight as a filter starts and stops.
    const measure = () => {
      const element = elementRef.current
      setTruncated(!!element && element.scrollWidth > element.clientWidth)
    }
    // The tree focuses the row's treeitem, which also holds the rows nested under it.
    const item = row.closest('[role="treeitem"]') ?? row
    const focusIn = (event: Event) => {
      const target = event.target
      if (target === item || (target instanceof Node && row.contains(target))) measure()
    }
    row.addEventListener('mouseenter', measure)
    item.addEventListener('focusin', focusIn)
    return () => {
      row.removeEventListener('mouseenter', measure)
      item.removeEventListener('focusin', focusIn)
    }
  }, [])

  return (
    <Tooltip label={label} openDelay={TOOLTIP_DELAY} withinPortal disabled={!truncated}>
      {highlight ? (
        <Highlight
          ref={setElement}
          highlight={highlight}
          size={size}
          fw={fw}
          truncate="end"
          style={{ minWidth: 0 }}
        >
          {label}
        </Highlight>
      ) : (
        <Text ref={setElement} size={size} fw={fw} c={c} truncate="end" style={{ minWidth: 0 }}>
          {label}
        </Text>
      )}
    </Tooltip>
  )
}

/**
 * A row's cut-off detail line in full once keyboard focus has rested on the row for
 * `TOOLTIP_DELAY`. Anchored to the whole row, below its focus ring or, without room, above it, so
 * it never covers the row's title; Escape hides it until focus next arrives (WCAG 1.4.13).
 */
const RowDetailTip: React.FC<{ detail?: string; children: React.ReactElement }> = ({
  detail,
  children,
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const row = rowRef.current
    const item = row?.closest('[role="treeitem"]')
    if (!row || !item || !detail) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let open = false
    // While shown it also marks the row, so PreviewPane's Escape leaves the key to it.
    const show = (next: boolean) => {
      open = next
      setShown(next)
      if (next) item.setAttribute('data-mantine-stop-propagation', 'true')
      else item.removeAttribute('data-mantine-stop-propagation')
    }
    const cutOff = () => {
      const line = row.querySelector('[data-testid="entry-nav-detail"] > *')
      return !!line && line.scrollWidth > line.clientWidth
    }
    const onFocusIn = (event: Event) => {
      if (event.target !== item) return
      clearTimeout(timer)
      // Not after a click, which focuses the treeitem too and would pin it over the next row.
      timer = setTimeout(() => show(item.matches(':focus-visible') && cutOff()), TOOLTIP_DELAY)
    }
    const onFocusOut = (event: Event) => {
      if (event.target !== item) return
      clearTimeout(timer)
      show(false)
    }
    // Handled, so a panel's own Escape waits for the next press.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.target !== item) return
      clearTimeout(timer)
      if (!open) return
      event.preventDefault()
      show(false)
    }
    item.addEventListener('focusin', onFocusIn)
    item.addEventListener('focusout', onFocusOut)
    item.addEventListener('keydown', onKeyDown as EventListener)
    return () => {
      item.removeEventListener('focusin', onFocusIn)
      item.removeEventListener('focusout', onFocusOut)
      item.removeEventListener('keydown', onKeyDown as EventListener)
      clearTimeout(timer)
      show(false)
    }
  }, [detail])
  // Rendered without a detail too, so the row keeps its place in the tree as one arrives.
  return (
    <Tooltip
      ref={rowRef}
      label={detail ?? ''}
      disabled={!detail}
      opened={shown}
      position="bottom-start"
      // Clears the row's 2px focus ring and its 2px offset.
      offset={8}
      withinPortal
    >
      {children}
    </Tooltip>
  )
}

/** The keys Mantine's tree acts on, matched as it matches them, by `code`. */
const TREE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'])

/**
 * A row menu's dropdown is portaled, but React still bubbles its key events to the row, where the
 * tree's arrow keys would take focus out of the open menu. Only those keys stop: React's
 * stopPropagation stops the native event too, and every other key must still reach the document,
 * where the Mod+P shortcut and the focus traps' Tab handling listen.
 */
const stopTreeKeys = (event: React.KeyboardEvent) => {
  if (TREE_KEYS.has(event.nativeEvent.code)) event.stopPropagation()
}

const UnsavedDot: React.FC<{ label: string }> = ({ label }) => (
  <Tooltip label={label} withinPortal>
    <UnsavedMark role="img" aria-label={label} data-testid="unsaved-dot" />
  </Tooltip>
)

export const EntryNavigator: React.FC<EntryNavigatorProps> = ({
  items,
  collections,
  selectedPath,
  onSelect,
  onTreeControllerReady,
  expandedStateRef,
  onExpandedStateChange,
  onDeleteEntry: onDeleteEntryProp,
  onRenameEntry: onRenameEntryProp,
  onReorderEntry: onReorderEntryProp,
  hiddenRootPath,
  loading,
  readOnly = false,
  readOnlyReason,
  dirtyPaths,
  reveal,
  onRevealed,
  onEntryFilterChange,
  entryFilter = 'all',
  branchChanges,
  onShowUnsaved,
  unsavedCount: unsavedCountProp = 0,
  unsavedEntries,
  entryListFailed = false,
  branchNotAvailable = false,
  onSwitchBranch,
  onFilterEnter,
  onFilterEscape,
  onRowMenuOpen,
  filterRef,
  filterShortcut,
}) => {
  // Shadow the entry-mutation callbacks with undefined when readOnly, so every
  // downstream reference (hasEntryMenu, canReorder, the menu items themselves)
  // sees them as absent rather than threading a readOnly check through each
  // call site individually.
  const onDeleteEntry = readOnly ? undefined : onDeleteEntryProp
  const onRenameEntry = readOnly ? undefined : onRenameEntryProp
  const onReorderEntry = readOnly ? undefined : onReorderEntryProp

  const selectedNodeRef = useRef<HTMLDivElement>(null)
  const hasScrolledRef = useRef(false)
  // Track expanded state synchronously to avoid race conditions on unmount
  const localExpandedStateRef = useRef<Record<string, boolean>>(expandedStateRef?.current ?? {})

  const [query, setQuery] = useState('')
  const filterInputRef = useRef<HTMLInputElement>(null)
  const mergedFilterRef = useMergedRef(filterInputRef, filterRef)
  const unsavedOnly = entryFilter === 'unsaved' && !!onEntryFilterChange
  const changedMode = entryFilter === 'changed' && !!onEntryFilterChange && !!branchChanges
  const filtering = query.trim() !== '' || unsavedOnly || changedMode
  // Read from the tree's expand/collapse callbacks, which fire from state updaters.
  const filteringRef = useRef(false)
  useEffect(() => {
    filteringRef.current = filtering
  }, [filtering])
  const [otherFilesOpen, setOtherFilesOpen] = useState(false)
  const otherFilesId = useId()
  // Announced once per answer shown under Changed (SWR keeps an unchanged answer's identity).
  const [changesAnnouncement, setChangesAnnouncement] = useState('')
  const announcedChanges = changedMode ? branchChanges?.data : undefined
  useEffect(() => {
    if (!announcedChanges) return
    const entries = announcedChanges.entries.length
    const collections = announcedChanges.collections.length
    setChangesAnnouncement(
      entries + collections === 0
        ? 'No changed entries'
        : plural(entries, 'changed entry', 'changed entries') +
            (collections
              ? ` and ${plural(collections, 'changed collection', 'changed collections')}`
              : ''),
    )
  }, [announcedChanges])

  const treeData = useMemo<TreeNodeData[]>(() => {
    const entryNode = (
      entry: EntryNavItem,
      parent: EntryNavCollection,
      childIndex: number,
      totalChildren: number,
    ): TreeNodeData => ({
      value: entry.path,
      label: entry.label,
      nodeProps: {
        status: entry.status,
        route: entry.route,
        title: entry.title,
        missing: entry.missing,
        noPage: entry.noPage,
        isEntry: true,
        entryPath: entry.path,
        slug: entry.slug ?? lastSegment(entry.path),
        contentId: entry.contentId,
        conflictNotice: entry.conflictNotice,
        unavailable: entry.unavailable,
        itemReadOnly: entry.readOnly,
        parentCollectionPath: parent.path,
        childIndex,
        totalChildrenCount: totalChildren,
      },
    })

    if (collections?.length) {
      const toTree = (col: EntryNavCollection): TreeNodeData => {
        if (col.type === 'entry') {
          const entry = col.entries?.[0]
          return {
            value: entry?.path ?? `collection:${col.path}`,
            label: entry?.label ?? col.label,
            nodeProps: {
              status: entry?.status,
              route: entry?.route,
              title: entry?.title,
              missing: entry?.missing,
              noPage: entry?.noPage,
              isEntry: true,
              entryPath: entry?.path,
              collectionPath: col.path,
              slug: entry ? (entry.slug ?? lastSegment(entry.path)) : undefined,
              itemReadOnly: entry?.readOnly,
            },
            children: [],
          }
        }
        const entries = col.entries ?? []
        const childCollections = col.children ?? []
        const totalChildren = entries.length + childCollections.length
        const order = col.order ?? []

        const entryNodesByContentId = new Map<string, TreeNodeData>()
        entries.forEach((entry) => {
          if (entry.contentId) {
            entryNodesByContentId.set(entry.contentId, entryNode(entry, col, 0, totalChildren))
          }
        })

        const withPosition = (child: EntryNavCollection, childIndex: number): TreeNodeData => {
          const childTree = toTree(child)
          return {
            ...childTree,
            nodeProps: {
              ...childTree.nodeProps,
              contentId: child.contentId,
              parentCollectionPath: col.path,
              childIndex,
              totalChildrenCount: totalChildren,
            },
          }
        }

        const childNodesByContentId = new Map<string, TreeNodeData>()
        childCollections.forEach((child) => {
          if (child.contentId) {
            childNodesByContentId.set(child.contentId, withPosition(child, 0))
          }
        })

        const allChildren: TreeNodeData[] = []
        const usedContentIds = new Set<string>()

        for (const contentId of order) {
          const orderedEntry = entryNodesByContentId.get(contentId)
          if (orderedEntry) {
            orderedEntry.nodeProps = {
              ...orderedEntry.nodeProps,
              childIndex: allChildren.length,
            }
            allChildren.push(orderedEntry)
            usedContentIds.add(contentId)
            continue
          }
          const childNode = childNodesByContentId.get(contentId)
          if (childNode) {
            childNode.nodeProps = {
              ...childNode.nodeProps,
              childIndex: allChildren.length,
            }
            allChildren.push(childNode)
            usedContentIds.add(contentId)
          }
        }

        const unorderedEntries = entries
          .filter((e) => !e.contentId || !usedContentIds.has(e.contentId))
          .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
        for (const entry of unorderedEntries) {
          allChildren.push(entryNode(entry, col, allChildren.length, totalChildren))
        }

        const unorderedChildren = childCollections
          .filter((c) => !c.contentId || !usedContentIds.has(c.contentId))
          .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
        for (const child of unorderedChildren) {
          allChildren.push(withPosition(child, allChildren.length))
        }

        // Collections should always have children array (even if empty) to show chevron
        // This matches standard file tree UI behavior where folders always show expand/collapse
        return {
          value: `collection:${col.path}`,
          label: col.label,
          nodeProps: {
            isCollection: true,
            type: col.type,
            collectionPath: col.path,
            conflictNotice: col.conflictNotice,
            unavailableSchemaRefs: col.unavailableSchemaRefs,
            addRefused: col.addRefused,
            onAdd: col.onAdd,
            onEdit: col.onEdit,
            onAddSubCollection: col.onAddSubCollection,
            onDelete: col.onDelete,
          },
          children: allChildren,
        }
      }

      // If hiddenRootPath is set and matches a single root collection, return its children directly
      // This allows the root collection's order/context to be used for top-level item reordering
      if (hiddenRootPath && collections.length === 1 && collections[0].path === hiddenRootPath) {
        const rootNode = toTree(collections[0])
        return rootNode.children ?? []
      }

      return collections.map(toTree)
    }

    const flatItems = items ?? []
    return flatItems.map((item) => ({
      value: item.path,
      label: item.label,
      nodeProps: {
        status: item.status,
        route: item.route,
        title: item.title,
        missing: item.missing,
        noPage: item.noPage,
        isEntry: true,
        entryPath: item.path,
        slug: item.slug ?? lastSegment(item.path),
        itemReadOnly: item.readOnly,
      },
    }))
  }, [collections, items, hiddenRootPath])

  // Filtered from the finished tree, so each node keeps its position in the whole collection and
  // Move up / Move down stay correct while a filter is on.
  const changes = changedMode ? branchChanges?.data : undefined
  // Rows Changed keeps: entries with a row (not deleted ones) and collections whose settings changed.
  const { changedValues, entryChange, settingsChanged } = useMemo(() => {
    const values = new Set<string>()
    const byPath = new Map<string, BranchChangeEntry>()
    const settings = new Set<string>()
    for (const entry of changes?.entries ?? []) {
      if (entry.status === 'deleted') continue
      values.add(entry.logicalPath)
      byPath.set(entry.logicalPath, entry)
    }
    for (const collection of changes?.collections ?? []) {
      if (collection.status === 'deleted') continue
      values.add(`collection:${collection.logicalPath}`)
      settings.add(`collection:${collection.logicalPath}`)
    }
    return { changedValues: values, entryChange: byPath, settingsChanged: settings }
  }, [changes])

  const filteredTree = useMemo(
    () =>
      filtering
        ? filterTree(
            treeData,
            query,
            unsavedOnly ? (dirtyPaths ?? new Set()) : changedMode ? changedValues : undefined,
          )
        : treeData,
    [filtering, treeData, query, unsavedOnly, changedMode, dirtyPaths, changedValues],
  )

  // A caller may pass a new but equal `dirtyPaths` as drafts change: that alone never reopens a
  // folder the user closed, while a new query or new folders re-expand.
  const filteredFolders = useMemo(
    () => Object.keys(expandedStateFor(filteredTree)).join('\n'),
    [filteredTree],
  )

  // Collections that hold an entry with unsaved changes, found over the whole tree so a filter
  // never hides the reason for a dot.
  // `listedUnsaved` counts the unsaved entries the tree has rows for.
  const { dirtyCollections, listedUnsaved } = useMemo(() => {
    const dirty = new Set<string>()
    let listed = 0
    if (!dirtyPaths?.size) return { dirtyCollections: dirty, listedUnsaved: listed }
    const walk = (nodes: TreeNodeData[]): boolean => {
      let any = false
      for (const node of nodes) {
        if (node.nodeProps?.isEntry) {
          if (dirtyPaths.has(node.value)) {
            any = true
            listed += 1
          }
        } else if (walk(node.children ?? [])) {
          dirty.add(node.value)
          any = true
        }
      }
      return any
    }
    walk(treeData)
    return { dirtyCollections: dirty, listedUnsaved: listed }
  }, [treeData, dirtyPaths])

  const treeRows = useMemo(() => {
    const rows = new Set<string>()
    const walk = (nodes: TreeNodeData[]) =>
      nodes.forEach((node) => {
        rows.add(node.value)
        walk(node.children ?? [])
      })
    walk(treeData)
    return rows
  }, [treeData])
  // Unsaved entries the tree has no row for, which Unsaved offers beneath it.
  const unlistedNamed = useMemo(
    () => (unsavedOnly ? (unsavedEntries ?? []).filter((entry) => !treeRows.has(entry.path)) : []),
    [unsavedOnly, unsavedEntries, treeRows],
  )
  const unlistedMatches = useMemo(
    () => unlistedNamed.filter((entry) => matchesEntryQuery({ label: entry.label }, query)),
    [unlistedNamed, query],
  )
  // A collection's label from the tree, else its last segment humanised, as for one deleted.
  const collectionLabel = useMemo(() => {
    const labels = new Map<string, string>()
    const walk = (list: readonly EntryNavCollection[]) =>
      list.forEach((col) => {
        labels.set(col.path, col.label)
        walk(col.children ?? [])
      })
    walk(collections ?? [])
    return (path: string) => labels.get(path) ?? humanizeName(lastSegment(path))
  }, [collections])
  const slugLabel = (path: string) => humanizeName(lastSegment(path))
  const movedFrom = (entry: BranchChangeEntry): string | undefined => {
    const previous = entry.previousLogicalPath
    if (!previous) return undefined
    const parent = previous.slice(0, previous.lastIndexOf('/'))
    return parent === entry.collectionPath
      ? ` from ${slugLabel(previous)}`
      : ` from ${collectionLabel(parent)} › ${slugLabel(previous)}`
  }
  // Under Changed: entries with no row, the deleted ones and any the entry list doesn't hold yet,
  // and collections whose settings row is not drawn, such as the hidden root's.
  const changedBeneath = useMemo(() => {
    const matches = (label: string) => matchesEntryQuery({ label }, query)
    const unlisted = (changes?.entries ?? [])
      .filter((e) => e.status !== 'deleted' && !treeRows.has(e.logicalPath))
      .map((e) => ({ entry: e, path: e.logicalPath, label: e.title || slugLabel(e.logicalPath) }))
      .filter((e) => matches(e.label))
    const deleted = (changes?.entries ?? [])
      .filter((e) => e.status === 'deleted')
      .map((e) => ({
        path: e.logicalPath,
        label: e.title || slugLabel(e.logicalPath),
        collection: collectionLabel(e.collectionPath),
      }))
      .filter((e) => matches(e.label))
    const settings = (changes?.collections ?? [])
      .filter((c) => c.status === 'deleted' || !treeRows.has(`collection:${c.logicalPath}`))
      .map((c) => ({ path: c.logicalPath, label: collectionLabel(c.logicalPath) }))
      .filter((c) => matches(c.label))
    return { unlisted, deleted, settings }
  }, [changes, treeRows, query, collectionLabel])

  // The hidden root's own row never renders, so its message is shown once above the tree.
  const hiddenRootAddRefused =
    !readOnly &&
    !!hiddenRootPath &&
    collections?.length === 1 &&
    collections[0].path === hiddenRootPath &&
    !!collections[0].addRefused
  const hiddenRootUnavailableRefs =
    hiddenRootPath && collections?.length === 1 && collections[0].path === hiddenRootPath
      ? collections[0].unavailableSchemaRefs
      : undefined

  const tree = useTree({
    initialExpandedState: expandedStateRef?.current ?? {},
    // A filter expands and collapses nodes only for as long as it is on, so none of it is saved.
    onNodeExpand: (value) => {
      if (filteringRef.current) return
      localExpandedStateRef.current = {
        ...localExpandedStateRef.current,
        [value]: true,
      }
      onExpandedStateChange?.(localExpandedStateRef.current)
    },
    onNodeCollapse: (value) => {
      if (filteringRef.current) return
      localExpandedStateRef.current = {
        ...localExpandedStateRef.current,
        [value]: false,
      }
      onExpandedStateChange?.(localExpandedStateRef.current)
    },
  })

  useEffect(() => {
    onTreeControllerReady?.(tree)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when callback ref changes, not on tree state
  }, [onTreeControllerReady])

  // Empty dependency array ensures this only runs on mount/unmount, not on re-renders
  useEffect(() => {
    return () => {
      onExpandedStateChange?.(localExpandedStateRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The expanded state from before the filter started, put back exactly when it clears. The tree
  // drops the state of nodes it no longer renders, so it cannot be recovered from the tree itself.
  const expandedBeforeFilterRef = useRef<Record<string, boolean> | null>(null)
  const servedRevealRef = useRef<number>()
  const revealAwaitsRestoreRef = useRef(false)
  useEffect(() => {
    if (filtering) {
      expandedBeforeFilterRef.current ??= tree.expandedState
      tree.setExpandedState(expandedStateFor(filteredTree))
    } else if (expandedBeforeFilterRef.current) {
      // Plus the ancestors of an entry picked while filtering, so it stays in view.
      const next = {
        ...expandedBeforeFilterRef.current,
        ...calculatePathToEntry(selectedPath, treeData),
      }
      tree.setExpandedState(next)
      expandedBeforeFilterRef.current = null
      // A reveal that cleared the filter added its row's folders, kept as its own expansion is.
      if (reveal && servedRevealRef.current !== reveal.seq) {
        revealAwaitsRestoreRef.current = true
        localExpandedStateRef.current = next
        onExpandedStateChange?.(next)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the filter, its query or its folders change; `tree` is a fresh object each render
  }, [filtering, filteredFolders, query.trim()])

  useEffect(() => {
    if (!selectedPath || !treeData || filtering) return

    const savedState = expandedStateRef?.current ?? {}

    const pathToEntry = calculatePathToEntry(selectedPath, treeData)
    const baseState = { ...savedState, ...pathToEntry }

    // Only update if state actually changed to avoid infinite loops
    const currentStateJson = JSON.stringify(tree.expandedState)
    const newStateJson = JSON.stringify(baseState)
    if (currentStateJson !== newStateJson) {
      tree.setExpandedState(baseState)
      localExpandedStateRef.current = baseState
      onExpandedStateChange?.(baseState)
    }
    // Dependencies limited to data changes only to prevent infinite update loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, treeData])

  useEffect(() => {
    if (selectedPath && selectedNodeRef.current && !hasScrolledRef.current) {
      // Small delay to ensure tree expansion completes first
      const timeoutId = setTimeout(() => {
        selectedNodeRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest',
        })
        hasScrolledRef.current = true
      }, 100)

      return () => clearTimeout(timeoutId)
    }
  }, [selectedPath, tree.expandedState])

  useEffect(() => {
    hasScrolledRef.current = false
  }, [])

  const treeBoxRef = useRef<HTMLDivElement>(null)
  // Runs again as the filter clears and the expansion lands, then focuses the row a frame later.
  useEffect(() => {
    if (!reveal || !treeData || servedRevealRef.current === reveal.seq) {
      revealAwaitsRestoreRef.current = false
      return
    }
    const served = () => {
      servedRevealRef.current = reveal.seq
      onRevealed?.()
    }
    if (reveal.kind === 'unsaved') {
      setQuery('')
      served()
      return
    }
    // An empty tree that is still loading gets its rows; this runs again when they arrive.
    if (treeData.length === 0 && loading) return
    // This commit's expanded state predates the restore's, which re-runs this effect.
    if (revealAwaitsRestoreRef.current) {
      revealAwaitsRestoreRef.current = false
      return
    }
    const value =
      reveal.kind === 'collection'
        ? collectionNodeValue(treeData, reveal.path)
        : hasNode(treeData, reveal.path)
          ? reveal.path
          : undefined
    if (!value) {
      served()
      return
    }
    const wanted = {
      ...calculatePathToEntry(value, treeData),
      ...(reveal.kind === 'collection' ? { [value]: true } : {}),
    }
    if (filtering) {
      // The filter's restore expands the row's folders along with what was open before it.
      expandedBeforeFilterRef.current = {
        ...(expandedBeforeFilterRef.current ?? tree.expandedState),
        ...wanted,
      }
      setQuery('')
      if (entryFilter !== 'all') onEntryFilterChange?.('all')
      return
    }
    if (Object.keys(wanted).some((key) => !tree.expandedState[key])) {
      const next = { ...tree.expandedState, ...wanted }
      tree.setExpandedState(next)
      localExpandedStateRef.current = next
      onExpandedStateChange?.(next)
      return
    }
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        treeBoxRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
      ).find((item) => item.dataset.value === value)
      row?.scrollIntoView({ block: 'nearest' })
      row?.focus()
      served()
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tree` and the callbacks are fresh each render
  }, [reveal, treeData, filtering, loading, tree.expandedState])

  const clearFilter = () => {
    setQuery('')
    filterInputRef.current?.focus()
  }

  const handleFilterKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter and Escape during IME composition commit or cancel the composition, nothing more.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && (query || onFilterEscape)) {
      // A query clears and nothing else: the surrounding drawer stays open.
      event.preventDefault()
      event.stopPropagation()
      if (query) setQuery('')
      else onFilterEscape?.()
    } else if (event.key === 'Enter' && filtering) {
      const path =
        firstEntryPath(filteredTree, query) ??
        unlistedMatches[0]?.path ??
        (changedMode ? changedBeneath.unlisted[0]?.path : undefined)
      if (path) {
        event.preventDefault()
        ;(onFilterEnter ?? onSelect)(path)
      }
    }
  }

  const Chevron = ({ expanded, visible }: { expanded: boolean; visible: boolean }) => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ flexShrink: 0, opacity: visible ? 0.9 : 0 }}
    >
      {expanded ? (
        <path d="M7.41 8.59 12 13.17 16.59 8.59 18 10l-6 6-6-6z" />
      ) : (
        <path d="M10 6 8.59 7.41 13.17 12 8.59 16.59 10 18l6-6z" />
      )}
    </svg>
  )

  const renderNode = ({
    node,
    elementProps,
    hasChildren,
    expanded,
    level,
  }: RenderTreeNodePayload) => {
    const status = node.nodeProps?.status as string | undefined
    const entryMissing = !!(node.nodeProps?.missing as boolean | undefined)
    const entryNoPage = !!(node.nodeProps?.noPage as boolean | undefined)
    const route = node.nodeProps?.route as string | undefined
    const detail = entryMissing
      ? status
      : entryDetailLine({ typeLabel: status, route: entryNoPage ? undefined : route })
    // Collection-level mutation callbacks are nulled when readOnly, same as the entry-level ones
    // above, so hasCollectionMenu is false; a row that would have had a menu shows its lock.
    const rawOnAdd = node.nodeProps?.onAdd as (() => void) | undefined
    const rawOnEdit = node.nodeProps?.onEdit as (() => void) | undefined
    const rawOnAddSubCollection = node.nodeProps?.onAddSubCollection as (() => void) | undefined
    const rawOnDelete = node.nodeProps?.onDelete as (() => void) | undefined
    const onAdd = readOnly ? undefined : rawOnAdd
    const onEdit = readOnly ? undefined : rawOnEdit
    const onAddSubCollection = readOnly ? undefined : rawOnAddSubCollection
    const onDelete = readOnly ? undefined : rawOnDelete
    const entryPath = node.nodeProps?.entryPath as LogicalPath | undefined
    const contentId = node.nodeProps?.contentId as string | undefined
    const parentCollectionPath = node.nodeProps?.parentCollectionPath as LogicalPath | undefined
    const childIndex = node.nodeProps?.childIndex as number | undefined
    const totalChildrenCount = node.nodeProps?.totalChildrenCount as number | undefined
    const isCollection = node.nodeProps?.isCollection as boolean | undefined
    const isEntry = node.nodeProps?.isEntry as boolean | undefined
    const conflictNotice = node.nodeProps?.conflictNotice as boolean | undefined
    const unavailableSchemaRefs = node.nodeProps?.unavailableSchemaRefs as
      | readonly string[]
      | undefined
    // A read-only navigator already says writes are refused, so the add-refused line is not repeated.
    const addRefused = !readOnly && !!(node.nodeProps?.addRefused as boolean | undefined)
    const isLeaf = !hasChildren || isEntry
    const selected = node.value === selectedPath
    const label = String(node.label ?? '')
    const testIdSuffix = label.toLowerCase().replace(/\s+/g, '-')

    // For collections, always show chevron (even if empty) to match standard tree UI
    // Mantine only provides hasChildren=true if children.length > 0, but we want
    // collections to always be expandable
    const showChevron = hasChildren || Boolean(isCollection)

    const reorderPosition = contentId && parentCollectionPath && typeof childIndex === 'number'
    const canReorder = onReorderEntry && reorderPosition
    const canMoveUp = canReorder && childIndex > 0
    const canMoveDown =
      canReorder && typeof totalChildrenCount === 'number' && childIndex < totalChildrenCount - 1

    // Collections show menu for add/edit/delete actions OR for reordering (subcollections)
    const hasCollectionMenu =
      isCollection && (onAdd || onEdit || onAddSubCollection || onDelete || canReorder)
    // An unavailable entry cannot be written, so its menu (rename, delete, reorder) is not offered.
    const entryUnavailable = node.nodeProps?.unavailable as boolean | undefined
    // The same holds for an entry this user may not edit, on any branch: its own lock stays, since a
    // path rule, not the branch, refuses it, and the branch lock leaves that row's slot empty.
    const entryLocked = !!(node.nodeProps?.itemReadOnly as boolean | undefined)
    const hasEntryMenu =
      isEntry &&
      entryPath &&
      !entryUnavailable &&
      !entryLocked &&
      (onDeleteEntry || onRenameEntry || onReorderEntry)

    // The lock holds the slot where the menu would be, on exactly the rows that would otherwise have
    // one, so rows never shift. The stylesheet reveals it on the hovered, focused or selected
    // row (`data-nav-selected`), which keeps touch and keyboard users' route to the reason.
    const wouldHaveCollectionMenu =
      isCollection &&
      !!(
        rawOnAdd ||
        rawOnEdit ||
        rawOnAddSubCollection ||
        rawOnDelete ||
        (onReorderEntryProp && reorderPosition)
      )
    const wouldHaveEntryMenu =
      isEntry &&
      !!entryPath &&
      !entryUnavailable &&
      !entryLocked &&
      !!(onDeleteEntryProp || onRenameEntryProp || onReorderEntryProp)
    const showsLockSlot = readOnly && (wouldHaveCollectionMenu || wouldHaveEntryMenu)

    const rowChange = isEntry ? entryChange.get(node.value) : undefined
    const changeMarker: ChangeMarkerKind | undefined = rowChange
      ? rowChange.status
      : !isEntry && settingsChanged.has(node.value)
        ? 'settings'
        : undefined
    const showEntryDirtyDot = isEntry && !!entryPath && !!dirtyPaths?.has(entryPath)
    const showCollectionDirtyDot = !isEntry && dirtyCollections.has(node.value)

    const adminItems = onAddSubCollection || onEdit || onDelete
    const hasCollectionContentItems = onAdd || canReorder

    return (
      <RowDetailTip detail={detail}>
        <Box
          {...elementProps}
          ref={selected ? selectedNodeRef : undefined}
          data-nav-row
          data-nav-selected={selected ? '' : undefined}
          data-testid={`entry-nav-item-${testIdSuffix}`}
          onClick={(event) => {
            elementProps.onClick(event)
            if (isLeaf && isEntry) {
              onSelect(node.value)
            }
          }}
          style={{
            ...elementProps.style,
            marginBottom: 4,
            borderRadius: 10,
            paddingInline: 10,
            paddingBlock: 6,
            paddingLeft: `calc(${rem(8)} + ${rem(level * 12)})`,
            backgroundColor: selected ? 'var(--mantine-primary-color-light)' : undefined,
            color: selected ? 'var(--mantine-primary-color-light-color)' : undefined,
            border: selected
              ? '1px solid var(--mantine-primary-color-light-color)'
              : '1px solid transparent',
            transition: 'background-color 120ms ease, border-color 120ms ease',
          }}
        >
          <Group gap="xs" justify="space-between" wrap="nowrap" style={{ width: '100%' }}>
            <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              <Box
                w={18}
                h={18}
                style={{
                  display: 'flex',
                  flexShrink: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Chevron expanded={expanded} visible={showChevron} />
              </Box>
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                  <TruncatedLabel
                    label={label}
                    highlight={filtering ? query.trim() : ''}
                    fw={selected ? 600 : 500}
                  />
                  {changeMarker && (
                    <ChangeMarker
                      kind={changeMarker}
                      context={(rowChange && movedFrom(rowChange)) ?? undefined}
                    />
                  )}
                  {showEntryDirtyDot && <UnsavedDot label="Unsaved changes" />}
                  {showCollectionDirtyDot && <UnsavedDot label="Contains unsaved changes" />}
                  {conflictNotice && (
                    <Tooltip
                      label="This content was updated on the base branch — a reviewer will reconcile"
                      withArrow
                    >
                      <Badge
                        size="xs"
                        variant="light"
                        color="orange"
                        data-testid="conflict-badge"
                        style={{ flexShrink: 0 }}
                      >
                        Conflict
                      </Badge>
                    </Tooltip>
                  )}
                  {entryLocked && (
                    <Tooltip label="You can't edit this entry" withinPortal>
                      <Box
                        component="span"
                        role="img"
                        aria-label="You can't edit this entry"
                        data-testid="entry-lock"
                        c="dimmed"
                        style={{ display: 'inline-flex', flexShrink: 0 }}
                      >
                        <IconLock size={14} aria-hidden />
                      </Box>
                    </Tooltip>
                  )}
                </Group>
                {detail && (
                  <Box data-testid="entry-nav-detail" style={{ minWidth: 0 }}>
                    <TruncatedLabel
                      label={detail}
                      size="xs"
                      // A missing file is an error, in error text, not a dimmed type.
                      c={entryMissing ? 'var(--canopy-danger-text)' : 'dimmed'}
                    />
                  </Box>
                )}
              </Stack>
            </Group>
            <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
              {hasCollectionMenu && (
                <Menu
                  shadow="md"
                  width={200}
                  withinPortal
                  position="bottom-end"
                  onOpen={onRowMenuOpen}
                >
                  <Menu.Target>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      onClick={(event) => event.stopPropagation()}
                      aria-label="Collection actions"
                      data-testid={`collection-menu-${testIdSuffix}`}
                    >
                      <IconDots size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown onKeyDown={stopTreeKeys}>
                    {onAdd && (
                      <Menu.Item
                        leftSection={<IconPlus size={14} />}
                        onClick={(event) => {
                          event.stopPropagation()
                          onAdd()
                        }}
                        data-testid="add-entry-menu-item"
                      >
                        Add entry…
                      </Menu.Item>
                    )}
                    {canReorder && (
                      <>
                        <ReasonedMenuItem
                          leftSection={<IconArrowUp size={14} />}
                          blockedReason={canMoveUp ? undefined : 'Already first'}
                          onClick={(event) => {
                            event.stopPropagation()
                            onReorderEntry?.(parentCollectionPath!, contentId!, 'up')
                          }}
                        >
                          Move up
                        </ReasonedMenuItem>
                        <ReasonedMenuItem
                          leftSection={<IconArrowDown size={14} />}
                          blockedReason={canMoveDown ? undefined : 'Already last'}
                          onClick={(event) => {
                            event.stopPropagation()
                            onReorderEntry?.(parentCollectionPath!, contentId!, 'down')
                          }}
                        >
                          Move down
                        </ReasonedMenuItem>
                      </>
                    )}
                    {adminItems && (
                      <>
                        {hasCollectionContentItems && <Menu.Divider />}
                        <Menu.Label>Admin</Menu.Label>
                      </>
                    )}
                    {onAddSubCollection && (
                      <Menu.Item
                        leftSection={<IconFolderPlus size={14} />}
                        onClick={(event) => {
                          event.stopPropagation()
                          onAddSubCollection()
                        }}
                      >
                        Add sub-collection…
                      </Menu.Item>
                    )}
                    {onEdit && (
                      <Menu.Item
                        leftSection={<IconEdit size={14} />}
                        onClick={(event) => {
                          event.stopPropagation()
                          onEdit()
                        }}
                      >
                        Edit collection…
                      </Menu.Item>
                    )}
                    {onDelete && (
                      <DestructiveMenuItem
                        leftSection={<IconTrash size={14} />}
                        onClick={(event) => {
                          event.stopPropagation()
                          onDelete()
                        }}
                      >
                        Delete collection
                      </DestructiveMenuItem>
                    )}
                  </Menu.Dropdown>
                </Menu>
              )}
              {showsLockSlot &&
                (readOnlyReason ? (
                  <BranchRowLock
                    label={isCollection ? 'Collection actions' : 'Entry actions'}
                    reason={readOnlyReason}
                  />
                ) : (
                  // The branch's state is still loading: hold the slot so rows do not shift. It draws
                  // nothing, so it needs no reveal.
                  <Box w={18} h={18} aria-hidden data-testid="branch-lock-pending" />
                ))}
              {hasEntryMenu && (
                <Menu
                  shadow="md"
                  width={180}
                  withinPortal
                  position="bottom-end"
                  onOpen={onRowMenuOpen}
                >
                  <Menu.Target>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      onClick={(event) => event.stopPropagation()}
                      aria-label="Entry actions"
                      data-testid={`entry-menu-${testIdSuffix}`}
                    >
                      <IconDots size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown onKeyDown={stopTreeKeys}>
                    {onRenameEntry && (
                      <Menu.Item
                        leftSection={<IconEdit size={14} />}
                        onClick={(event) => {
                          event.stopPropagation()
                          onRenameEntry(entryPath)
                        }}
                        data-testid="rename-entry-menu-item"
                      >
                        {entryNoPage ? EDITOR_ACTIONS.changeSlug : EDITOR_ACTIONS.changeUrl}…
                      </Menu.Item>
                    )}
                    {onReorderEntry && contentId && parentCollectionPath && (
                      <>
                        <ReasonedMenuItem
                          leftSection={<IconArrowUp size={14} />}
                          blockedReason={canMoveUp ? undefined : 'Already first'}
                          onClick={(event) => {
                            event.stopPropagation()
                            onReorderEntry(parentCollectionPath, contentId, 'up')
                          }}
                        >
                          Move up
                        </ReasonedMenuItem>
                        <ReasonedMenuItem
                          leftSection={<IconArrowDown size={14} />}
                          blockedReason={canMoveDown ? undefined : 'Already last'}
                          onClick={(event) => {
                            event.stopPropagation()
                            onReorderEntry(parentCollectionPath, contentId, 'down')
                          }}
                        >
                          Move down
                        </ReasonedMenuItem>
                      </>
                    )}
                    {onDeleteEntry && (
                      <>
                        {(onRenameEntry ||
                          (onReorderEntry && contentId && parentCollectionPath)) && (
                          <Menu.Divider />
                        )}
                        <DestructiveMenuItem
                          leftSection={<IconTrash size={14} />}
                          onClick={(event) => {
                            event.stopPropagation()
                            onDeleteEntry(entryPath)
                          }}
                          data-testid="delete-entry-menu-item"
                        >
                          Delete entry
                        </DestructiveMenuItem>
                      </>
                    )}
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
          </Group>
          {isCollection && unavailableSchemaRefs && unavailableSchemaRefs.length > 0 && (
            <UnavailableTypeRow schemaRefs={unavailableSchemaRefs} />
          )}
          {isCollection && addRefused && <AddRefusedRow />}
        </Box>
      </RowDetailTip>
    )
  }

  // Unsaved can't list every entry it counts: those with no row are offered beneath the tree, and
  // drafts whose entries aren't named yet are counted there.
  const unsavedCount = Math.max(unsavedCountProp, listedUnsaved + unlistedNamed.length)
  const unnamedUnsaved = unsavedCount - listedUnsaved - unlistedNamed.length
  const showAll = () => {
    onEntryFilterChange?.('all')
    filterInputRef.current?.focus()
  }
  const outsideRows = unlistedMatches.length > 0 && (
    <Stack gap={2} py={4} align="flex-start" data-testid="entry-nav-unsaved-outside">
      <Text size="xs" c="dimmed">
        Not in the content tree
      </Text>
      {unlistedMatches.map((entry) => (
        <Button
          key={entry.path}
          size="compact-sm"
          variant="subtle"
          color="gray"
          leftSection={<UnsavedMark aria-hidden="true" />}
          onClick={() => onSelect(entry.path)}
        >
          {entry.label}
        </Button>
      ))}
    </Stack>
  )
  const unsavedNotice = !unsavedOnly ? null : entryListFailed ? (
    <Text size="sm" c="dimmed" py="sm" data-testid="entry-nav-unsaved-failed">
      The list of entries couldn&apos;t be loaded, so unsaved entries can&apos;t be shown. Choose
      &quot;Refresh branch&quot; in the branch menu to try again.
    </Text>
  ) : query.trim() ? (
    <>
      {filteredTree.length === 0 && !outsideRows && (
        <Stack gap={4} py="sm" align="flex-start" data-testid="entry-nav-unsaved-no-match">
          <Text size="sm" c="dimmed">
            No unsaved entries match “{query}”.
          </Text>
          <Button size="compact-sm" variant="subtle" onClick={showAll}>
            Search all entries
          </Button>
        </Stack>
      )}
      {outsideRows}
    </>
  ) : unsavedCount === 0 ? (
    treeData.length > 0 && (
      <Stack gap={4} py="sm" align="flex-start" data-testid="entry-nav-unsaved-none">
        <Text size="sm" c="dimmed">
          No unsaved changes on this branch.
        </Text>
        <Button size="compact-sm" variant="subtle" onClick={showAll}>
          Show all entries
        </Button>
      </Stack>
    )
  ) : (
    <>
      {outsideRows}
      {unnamedUnsaved > 0 && (
        <Text size="sm" c="dimmed" py={4} data-testid="entry-nav-unsaved-unlisted">
          {listedUnsaved + unlistedNamed.length > 0
            ? `${unnamedUnsaved} more: `
            : `${unnamedUnsaved} unsaved ${unnamedUnsaved === 1 ? 'entry' : 'entries'}: `}
          {unnamedUnsaved === 1 ? 'loading its name…' : 'loading their names…'}
        </Text>
      )}
    </>
  )

  // Changed: what the branch differs from its base in.
  const changesData = branchChanges?.data
  const changedCount = changesData && changesData.entries.length + changesData.collections.length
  const changesError = changedMode ? branchChanges?.error : undefined
  const changesLoading = changedMode && !changesData && !changesError
  const base = branchChanges?.base ?? ''
  const changedHeader = changedMode && (
    <>
      {changesError && (
        <Alert
          my={4}
          p="xs"
          variant="light"
          color={changesError.kind === 'syncing' ? 'yellow' : 'red'}
          icon={
            changesError.kind === 'syncing' ? (
              <IconAlertTriangle size={16} />
            ) : (
              <IconAlertCircle size={16} />
            )
          }
          data-testid={`entry-nav-branch-changed-${changesError.kind}`}
        >
          <Stack gap={4} align="flex-start">
            <Text size="sm">
              {changesError.kind === 'syncing'
                ? (changesError.message ??
                  `This branch is being synced with ${base}. Try again in a moment.`)
                : changesData
                  ? 'Couldn’t refresh this branch’s changes. The list may be out of date.'
                  : 'Couldn’t load this branch’s changes.'}
            </Text>
            <Button
              size="compact-sm"
              variant="subtle"
              loading={branchChanges?.retrying}
              onClick={branchChanges?.onRetry}
            >
              Retry
            </Button>
          </Stack>
        </Alert>
      )}
      {changesData?.baseMissing && (
        <Stack gap={4} py="sm" align="flex-start" data-testid="entry-nav-branch-changed-missing">
          <Text size="sm" c="dimmed">
            Couldn’t compare this branch with {base}: {base} no longer exists.
          </Text>
          <Button size="compact-sm" variant="subtle" onClick={showAll}>
            Show all entries
          </Button>
        </Stack>
      )}
      {changesData?.baseUnavailable && (
        <Stack
          gap={4}
          py="sm"
          align="flex-start"
          data-testid="entry-nav-branch-changed-unavailable"
        >
          <Text size="sm" c="dimmed">
            Couldn’t compare this branch with {base}: they share no history.
          </Text>
          <Button size="compact-sm" variant="subtle" onClick={showAll}>
            Show all entries
          </Button>
        </Stack>
      )}
      {changesData?.hiddenChanges && (
        <Text size="sm" c="dimmed" py={4} data-testid="entry-nav-branch-changed-hidden">
          Some changes are in entries you can’t view.
        </Text>
      )}
    </>
  )
  const { unlisted: changedUnlisted, deleted: changedDeleted, settings } = changedBeneath
  const changedRows = (changedUnlisted.length > 0 ||
    changedDeleted.length > 0 ||
    settings.length > 0) && (
    <>
      {(changedUnlisted.length > 0 || settings.length > 0) && (
        <Stack gap={2} py={4} align="flex-start" data-testid="entry-nav-branch-changed-outside">
          <Text size="xs" c="dimmed">
            Not in the content tree
          </Text>
          {changedUnlisted.map((entry) => (
            <Button
              key={entry.path}
              size="compact-sm"
              variant="subtle"
              color="gray"
              rightSection={
                <ChangeMarker
                  kind={entry.entry.status}
                  context={movedFrom(entry.entry) ?? undefined}
                />
              }
              onClick={() => onSelect(entry.path)}
            >
              {entry.label}
            </Button>
          ))}
          {settings.map((collection) => (
            <Group key={collection.path} gap={6} px={10} wrap="nowrap">
              <Text size="sm">{collection.label}</Text>
              <ChangeMarker kind="settings" />
            </Group>
          ))}
        </Stack>
      )}
      {changedDeleted.length > 0 && (
        <Stack gap={2} py={4} align="flex-start" data-testid="entry-nav-branch-changed-deleted">
          <Text size="xs" c="dimmed">
            Deleted on this branch
          </Text>
          {changedDeleted.map((entry) => (
            <Group key={entry.path} gap={6} px={10} wrap="nowrap" style={{ minWidth: 0 }}>
              <Text size="sm" truncate="end" style={{ minWidth: 0 }}>
                {entry.label}{' '}
                <Text component="span" size="xs" c="dimmed">
                  {entry.collection}
                </Text>
              </Text>
              <ChangeMarker kind="deleted" context={null} />
            </Group>
          ))}
        </Stack>
      )}
    </>
  )
  const otherFiles = changedMode ? (changesData?.otherFiles ?? []) : []
  const otherFilesDetails = otherFiles.length > 0 && (
    <Stack gap={2} py={4} align="flex-start" data-testid="entry-nav-branch-changed-other">
      <Text size="xs" c="dimmed">
        Other files changed
      </Text>
      <Anchor
        component="button"
        type="button"
        size="xs"
        px={10}
        aria-expanded={otherFilesOpen}
        aria-controls={otherFilesOpen ? otherFilesId : undefined}
        onClick={() => setOtherFilesOpen((open) => !open)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
      >
        <IconChevronRight
          size={12}
          aria-hidden
          style={{
            transform: otherFilesOpen ? 'rotate(90deg)' : undefined,
            transition: 'transform 120ms ease',
          }}
        />
        Details
      </Anchor>
      {otherFilesOpen && (
        <Stack id={otherFilesId} gap={2} w="100%">
          <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {otherFiles.join('\n')}
          </Code>
          {changesData?.otherFilesTruncated && (
            <Text size="xs" c="dimmed">
              List shows the first {otherFiles.length} files.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  )
  const nothingChanged =
    !!changesData &&
    !changesData.baseUnavailable &&
    !changesData.baseMissing &&
    !changesData.hiddenChanges &&
    changesData.entries.length === 0 &&
    changesData.collections.length === 0
  const branchChangedNotice =
    !changedMode || !changesData ? null : query.trim() &&
      filteredTree.length === 0 &&
      !changedRows ? (
      <Stack gap={4} py="sm" align="flex-start" data-testid="entry-nav-branch-changed-no-match">
        <Text size="sm" c="dimmed">
          No changed entries match “{query}”.
        </Text>
        <Button size="compact-sm" variant="subtle" onClick={showAll}>
          Search all entries
        </Button>
      </Stack>
    ) : (
      <>
        {nothingChanged && (
          <Stack gap={4} py="sm" align="flex-start" data-testid="entry-nav-branch-changed-none">
            <Text size="sm" c="dimmed">
              Nothing on this branch differs from {base} yet.
            </Text>
            <Button size="compact-sm" variant="subtle" onClick={showAll}>
              Show all entries
            </Button>
            {unsavedCount > 0 && (
              <>
                <Text size="sm" c="dimmed" data-testid="entry-nav-branch-changed-unsaved">
                  {unsavedCount === 1
                    ? '1 unsaved entry isn’t included until it’s saved.'
                    : `${unsavedCount} unsaved entries aren’t included until they’re saved.`}
                </Text>
                <Button
                  size="compact-sm"
                  variant="subtle"
                  onClick={onShowUnsaved ?? (() => onEntryFilterChange?.('unsaved'))}
                >
                  Show unsaved
                </Button>
              </>
            )}
          </Stack>
        )}
        {changedRows}
        {otherFilesDetails}
      </>
    )
  const modeNotice = unsavedOnly ? unsavedNotice : branchChangedNotice
  const changesSkeleton = (
    <Stack gap={10} py="sm" px={10} aria-hidden data-testid="entry-nav-branch-changed-loading">
      {[70, 55, 80, 45].map((width, i) => (
        <Group key={i} gap={6} wrap="nowrap" pl={i % 2 ? 18 : 0}>
          <Skeleton h={12} w={`${width}%`} />
          <Skeleton h={12} w={40} />
        </Group>
      ))}
    </Stack>
  )

  return (
    <Stack
      h="100%"
      style={{ display: 'flex', flexDirection: 'column' }}
      gap={0}
      data-testid="entry-navigator"
    >
      {treeData.length > 0 && (
        <TextInput
          ref={mergedFilterRef}
          size="sm"
          py={4}
          aria-label="Find entries"
          aria-keyshortcuts={filterShortcut?.keys}
          spellCheck={false}
          data-autofocus
          placeholder="Find entries"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={handleFilterKeyDown}
          leftSection={<IconSearch size={14} aria-hidden />}
          rightSection={
            query ? (
              <Tooltip label="Clear search" withinPortal>
                <CloseButton size="sm" aria-label="Clear search" onClick={clearFilter} />
              </Tooltip>
            ) : filterShortcut ? (
              // The placeholder's colour, so it never reads brighter than the placeholder beside it.
              <Text
                size="xs"
                c="var(--mantine-color-placeholder)"
                aria-hidden
                data-testid="entry-nav-filter-shortcut"
              >
                {filterShortcut.label}
              </Text>
            ) : null
          }
          rightSectionWidth={query || !filterShortcut ? undefined : 'auto'}
          rightSectionPointerEvents={query ? undefined : 'none'}
          rightSectionProps={query || !filterShortcut ? undefined : { style: { paddingInline: 8 } }}
          // Mantine's drawers and modals ignore an Escape from an element with this attribute.
          data-mantine-stop-propagation={query || onFilterEscape ? 'true' : undefined}
          data-testid="entry-nav-filter"
        />
      )}
      {onEntryFilterChange && (treeData.length > 0 || unsavedCount > 0 || !!branchChanges) && (
        <SegmentedControl
          size="xs"
          fullWidth
          mb={4}
          aria-label="Entries shown"
          value={unsavedOnly ? 'unsaved' : changedMode ? 'changed' : 'all'}
          onChange={(value) => onEntryFilterChange(value as EntryFilter)}
          data={[
            { value: 'all', label: 'All' },
            {
              value: 'unsaved',
              label: unsavedCount > 0 ? `Unsaved ${segmentCount(unsavedCount)}` : 'Unsaved',
            },
            ...(branchChanges
              ? [
                  {
                    value: 'changed',
                    label: changedCount ? `Changed ${segmentCount(changedCount)}` : 'Changed',
                  },
                ]
              : []),
          ]}
          data-testid="entry-nav-shown"
        />
      )}
      {branchChanges && (
        <VisuallyHidden role="status" data-testid="entry-nav-branch-changed-status">
          {changesAnnouncement}
        </VisuallyHidden>
      )}
      <ScrollArea type="auto" scrollbars="y" offsetScrollbars style={{ flex: 1 }}>
        {changedHeader}
        {hiddenRootUnavailableRefs && hiddenRootUnavailableRefs.length > 0 && (
          <Box pt="sm">
            <UnavailableTypeRow schemaRefs={hiddenRootUnavailableRefs} />
          </Box>
        )}
        {hiddenRootAddRefused && (
          <Box pt="sm">
            <AddRefusedRow />
          </Box>
        )}
        {treeData.length === 0 ? (
          branchNotAvailable ? (
            <BranchNotAvailableNotice
              onSwitchBranch={onSwitchBranch}
              data-testid="entry-nav-branch-not-available"
            />
          ) : loading ? (
            <Group gap="xs" py="sm">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                Loading content…
              </Text>
            </Group>
          ) : changesLoading ? (
            changesSkeleton
          ) : modeNotice ? (
            modeNotice
          ) : (
            <Text size="xs" c="dimmed" py="sm">
              No content
            </Text>
          )
        ) : changesLoading ? (
          changesSkeleton
        ) : changedMode && !changesData ? null : filteredTree.length === 0 &&
          (unsavedOnly || changedMode) ? (
          modeNotice
        ) : filteredTree.length === 0 ? (
          <Stack gap={4} py="sm" align="flex-start" data-testid="entry-nav-filter-empty">
            <Text size="sm" c="dimmed">
              No entries match “{query}”.
            </Text>
            <Button size="compact-sm" variant="subtle" onClick={clearFilter}>
              Clear search
            </Button>
          </Stack>
        ) : (
          <Box py="sm" ref={treeBoxRef}>
            <Tree
              data={filteredTree}
              tree={tree}
              renderNode={renderNode}
              selectOnClick={false}
              levelOffset="sm"
            />
            {modeNotice}
          </Box>
        )}
      </ScrollArea>
    </Stack>
  )
}

export default EntryNavigator
