'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContentId, LogicalPath } from '../paths/types'

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  CloseButton,
  Group,
  Highlight,
  Loader,
  Menu,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  Tree,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
  rem,
} from '@mantine/core'
import {
  IconArrowDown,
  IconAlertTriangle,
  IconArrowUp,
  IconDots,
  IconEdit,
  IconFolderPlus,
  IconLock,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react'

import { calculatePathToEntry } from './editor-utils'
import { matchesEntryQuery } from './entry-search'
import { EDITOR_ACTIONS } from './copy'
import { DestructiveMenuItem } from './components/DestructiveMenuItem'
import { UnsavedMark } from './components/UnsavedMark'
import { BranchRowLock } from './components/BranchRowLock'
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
  /** The row's second line: the entry's type, or "Missing" (`entryStatusLabel`). */
  status?: string
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
   * When true, replaces every row's mutation menu (create, rename, delete, reorder, add/edit
   * collection) with a lock -- selection/navigation stays enabled. Set on a branch that takes no
   * writes, where they would only 403 after the fact. Default false.
   */
  readOnly?: boolean
  /**
   * Why the branch takes no writes (`describeBranchLock`), the tooltip of each row's lock. While
   * readOnly without one, the lock's slot stays empty.
   */
  readOnlyReason?: string
  /** Entry paths with unsaved changes; each shows a dot, and so does every collection holding one. */
  dirtyPaths?: ReadonlySet<string>
  /**
   * A collection to bring into view: any filter clears, its ancestors and itself expand, and its
   * row takes focus. `seq` makes a repeat ask for the same collection a new one.
   */
  revealCollection?: { path: string; seq: number }
  /** The reveal is done, or its collection is not in the tree. */
  onRevealed?: () => void
}

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
 * The nodes of `nodes` that match `query`. An entry matches on label or slug; a collection whose
 * label matches keeps its whole subtree, and any other collection survives only with its matching
 * descendants. Nodes keep the position data (`childIndex`, `totalChildrenCount`) of the full tree.
 */
const filterTree = (nodes: TreeNodeData[], query: string): TreeNodeData[] => {
  const kept: TreeNodeData[] = []
  for (const node of nodes) {
    const label = String(node.label ?? '')
    if (node.nodeProps?.isEntry) {
      const { slug, title } = node.nodeProps as { slug?: string; title?: string }
      if (matchesEntryQuery({ label, title, slug }, query)) {
        kept.push(node)
      }
    } else if (matchesEntryQuery({ label }, query)) {
      kept.push(node)
    } else {
      const children = filterTree(node.children ?? [], query)
      if (children.length > 0) kept.push({ ...node, children })
    }
  }
  return kept
}

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

/**
 * A line of a row, truncated with an ellipsis. Its full text shows in a tooltip, and only while
 * the text is cut: the width is measured when the pointer or focus enters the row, not on every
 * render.
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
    row.addEventListener('mouseenter', measure)
    row.addEventListener('focusin', measure)
    return () => {
      row.removeEventListener('mouseenter', measure)
      row.removeEventListener('focusin', measure)
    }
  }, [])

  return (
    <Tooltip label={label} openDelay={400} withinPortal disabled={!truncated}>
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
  revealCollection,
  onRevealed,
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
  const filtering = query.trim() !== ''
  // Read from the tree's expand/collapse callbacks, which fire from state updaters.
  const filteringRef = useRef(false)
  useEffect(() => {
    filteringRef.current = filtering
  }, [filtering])

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
  const filteredTree = useMemo(
    () => (filtering ? filterTree(treeData, query) : treeData),
    [filtering, treeData, query],
  )

  // Collections that hold an entry with unsaved changes, found over the whole tree so a filter
  // never hides the reason for a dot.
  const dirtyCollections = useMemo(() => {
    const dirty = new Set<string>()
    if (!dirtyPaths?.size) return dirty
    const walk = (nodes: TreeNodeData[]): boolean => {
      let any = false
      for (const node of nodes) {
        if (node.nodeProps?.isEntry) {
          if (dirtyPaths.has(node.value)) any = true
        } else if (walk(node.children ?? [])) {
          dirty.add(node.value)
          any = true
        }
      }
      return any
    }
    walk(treeData)
    return dirty
  }, [treeData, dirtyPaths])

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
  useEffect(() => {
    if (filtering) {
      expandedBeforeFilterRef.current ??= tree.expandedState
      tree.setExpandedState(expandedStateFor(filteredTree))
    } else if (expandedBeforeFilterRef.current) {
      // Plus the ancestors of an entry picked while filtering, so it stays in view.
      tree.setExpandedState({
        ...expandedBeforeFilterRef.current,
        ...calculatePathToEntry(selectedPath, treeData),
      })
      expandedBeforeFilterRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the filter or the filtered tree changes; `tree` is a fresh object each render
  }, [filtering, filteredTree])

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
  const servedRevealRef = useRef<number>()
  // Runs again as the filter clears and the expansion lands, then focuses the row a frame later.
  useEffect(() => {
    if (!revealCollection || !treeData || servedRevealRef.current === revealCollection.seq) return
    const served = () => {
      servedRevealRef.current = revealCollection.seq
      onRevealed?.()
    }
    if (query) {
      setQuery('')
      return
    }
    const value = collectionNodeValue(treeData, revealCollection.path)
    if (!value) {
      served()
      return
    }
    const wanted = { ...calculatePathToEntry(value, treeData), [value]: true }
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
  }, [revealCollection, treeData, query, tree.expandedState])

  const clearFilter = () => {
    setQuery('')
    filterInputRef.current?.focus()
  }

  const handleFilterKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter and Escape during IME composition commit or cancel the composition, nothing more.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && query) {
      // Clears the filter and nothing else: the surrounding drawer stays open.
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    } else if (event.key === 'Enter' && filtering) {
      const path = firstEntryPath(filteredTree, query)
      if (path) {
        event.preventDefault()
        onSelect(path)
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
    // A read-only navigator says so in each row's lock, so the add-refused line is not repeated.
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
    // The same holds for an entry this user may not edit, on any branch: its own lock stays, since
    // creating a branch would not lift it, and the branch lock leaves that row's slot empty.
    const entryLocked = !!(node.nodeProps?.itemReadOnly as boolean | undefined)
    const hasEntryMenu =
      isEntry &&
      entryPath &&
      !entryUnavailable &&
      !entryLocked &&
      (onDeleteEntry || onRenameEntry || onReorderEntry)

    // The lock stands where the menu would, on exactly the rows that would otherwise have one. It
    // is always shown: on hover alone, touch and keyboard users would see neither menu nor reason.
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

    const showEntryDirtyDot = isEntry && !!entryPath && !!dirtyPaths?.has(entryPath)
    const showCollectionDirtyDot = !isEntry && dirtyCollections.has(node.value)

    const adminItems = onAddSubCollection || onEdit || onDelete
    const hasCollectionContentItems = onAdd || canReorder

    return (
      <Box
        {...elementProps}
        ref={selected ? selectedNodeRef : undefined}
        data-nav-row
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
              {status && (
                <Box data-testid="entry-nav-type" style={{ minWidth: 0 }}>
                  <TruncatedLabel
                    label={status}
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
              <Menu shadow="md" width={200} withinPortal position="bottom-end">
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
                // The branch's state is still loading: hold the slot so rows do not shift.
                <Box w={18} h={18} aria-hidden data-testid="branch-lock-pending" />
              ))}
            {hasEntryMenu && (
              <Menu shadow="md" width={180} withinPortal position="bottom-end">
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
                      {(onRenameEntry || (onReorderEntry && contentId && parentCollectionPath)) && (
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
    )
  }

  return (
    <Stack
      h="100%"
      style={{ display: 'flex', flexDirection: 'column' }}
      gap={0}
      data-testid="entry-navigator"
    >
      {treeData.length > 0 && (
        <TextInput
          ref={filterInputRef}
          size="sm"
          py={4}
          aria-label="Filter entries"
          spellCheck={false}
          data-autofocus
          placeholder="Filter by title or slug"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={handleFilterKeyDown}
          leftSection={<IconSearch size={14} aria-hidden />}
          rightSection={
            query ? <CloseButton size="sm" aria-label="Clear filter" onClick={clearFilter} /> : null
          }
          // Mantine's drawers and modals ignore an Escape from an element with this attribute.
          data-mantine-stop-propagation={query ? 'true' : undefined}
          data-testid="entry-nav-filter"
        />
      )}
      <ScrollArea type="auto" scrollbars="y" offsetScrollbars style={{ flex: 1 }}>
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
          loading ? (
            <Group gap="xs" py="sm">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                Loading content…
              </Text>
            </Group>
          ) : (
            <Text size="xs" c="dimmed" py="sm">
              No content
            </Text>
          )
        ) : filteredTree.length === 0 ? (
          <Stack gap={4} py="sm" align="flex-start" data-testid="entry-nav-filter-empty">
            <Text size="sm" c="dimmed">
              No entries match “{query}”.
            </Text>
            <Button size="compact-sm" variant="subtle" onClick={clearFilter}>
              Clear filter
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
          </Box>
        )}
      </ScrollArea>
    </Stack>
  )
}

export default EntryNavigator
