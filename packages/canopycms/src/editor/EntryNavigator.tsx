'use client'

import React, { useMemo, useRef, useEffect } from 'react'
import type { ContentId, LogicalPath } from '../paths/types'

import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  Tree,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
  rem,
} from '@mantine/core'
import {
  IconArrowDown,
  IconArrowUp,
  IconDots,
  IconEdit,
  IconFolderPlus,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'

import { calculatePathToEntry } from './editor-utils'

// TreeController type from Mantine's useTree hook
type TreeController = ReturnType<typeof useTree>

export interface EntryNavItem {
  path: LogicalPath
  label: string
  status?: string
  collectionPath?: LogicalPath
  contentId?: ContentId // 12-char embedded ID for ordering
  /** True when this entry's file conflicted during rebase */
  conflictNotice?: boolean
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
  /** Called when user requests to rename an entry */
  onRenameEntry?: (path: LogicalPath) => void
  /** Called when user reorders an entry within a collection */
  onReorderEntry?: (
    collectionPath: LogicalPath,
    contentId: string,
    direction: 'up' | 'down',
  ) => void
  /** If provided, this collection path's node is hidden but its children are rendered at the top level */
  hiddenRootPath?: string
}

export const EntryNavigator: React.FC<EntryNavigatorProps> = ({
  items,
  collections,
  selectedPath,
  onSelect,
  onTreeControllerReady,
  expandedStateRef,
  onExpandedStateChange,
  onDeleteEntry,
  onRenameEntry,
  onReorderEntry,
  hiddenRootPath,
}) => {
  const selectedNodeRef = useRef<HTMLDivElement>(null)
  const hasScrolledRef = useRef(false)
  // Track expanded state synchronously to avoid race conditions on unmount
  const localExpandedStateRef = useRef<Record<string, boolean>>(expandedStateRef?.current ?? {})
  const treeData = useMemo<TreeNodeData[]>(() => {
    if (collections?.length) {
      const toTree = (col: EntryNavCollection): TreeNodeData => {
        if (col.type === 'entry') {
          const entry = col.entries?.[0]
          return {
            value: entry?.path ?? `collection:${col.path}`,
            label: entry?.label ?? col.label,
            nodeProps: {
              status: entry?.status,
              isEntry: true,
              entryPath: entry?.path,
            },
            children: [],
          }
        }
        const entries = col.entries ?? []
        const childCollections = col.children ?? []
        const totalChildren = entries.length + childCollections.length
        const order = col.order ?? []

        // Build entry nodes keyed by contentId
        const entryNodesByContentId = new Map<string, TreeNodeData>()
        entries.forEach((entry) => {
          const node: TreeNodeData = {
            value: entry.path,
            label: entry.label,
            nodeProps: {
              status: entry.status,
              isEntry: true,
              entryPath: entry.path,
              contentId: entry.contentId,
              conflictNotice: entry.conflictNotice,
              parentCollectionPath: col.path,
              childIndex: 0, // Will be set below
              totalChildrenCount: totalChildren,
            },
          }
          if (entry.contentId) {
            entryNodesByContentId.set(entry.contentId, node)
          }
        })

        // Build child collection nodes keyed by contentId
        const childNodesByContentId = new Map<string, TreeNodeData>()
        childCollections.forEach((child) => {
          const childTree = toTree(child)
          const node: TreeNodeData = {
            ...childTree,
            nodeProps: {
              ...childTree.nodeProps,
              contentId: child.contentId,
              parentCollectionPath: col.path,
              childIndex: 0, // Will be set below
              totalChildrenCount: totalChildren,
            },
          }
          if (child.contentId) {
            childNodesByContentId.set(child.contentId, node)
          }
        })

        // Interleave entries and children based on order array
        const allChildren: TreeNodeData[] = []
        const usedContentIds = new Set<string>()

        // First, add items in order
        for (const contentId of order) {
          const entryNode = entryNodesByContentId.get(contentId)
          if (entryNode) {
            entryNode.nodeProps = {
              ...entryNode.nodeProps,
              childIndex: allChildren.length,
            }
            allChildren.push(entryNode)
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

        // Add any entries not in order (alphabetically)
        const unorderedEntries = entries
          .filter((e) => !e.contentId || !usedContentIds.has(e.contentId))
          .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
        for (const entry of unorderedEntries) {
          const node: TreeNodeData = {
            value: entry.path,
            label: entry.label,
            nodeProps: {
              status: entry.status,
              isEntry: true,
              entryPath: entry.path,
              contentId: entry.contentId,
              conflictNotice: entry.conflictNotice,
              parentCollectionPath: col.path,
              childIndex: allChildren.length,
              totalChildrenCount: totalChildren,
            },
          }
          allChildren.push(node)
        }

        // Add any child collections not in order (alphabetically)
        const unorderedChildren = childCollections
          .filter((c) => !c.contentId || !usedContentIds.has(c.contentId))
          .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
        for (const child of unorderedChildren) {
          const childTree = toTree(child)
          const node: TreeNodeData = {
            ...childTree,
            nodeProps: {
              ...childTree.nodeProps,
              contentId: child.contentId,
              parentCollectionPath: col.path,
              childIndex: allChildren.length,
              totalChildrenCount: totalChildren,
            },
          }
          allChildren.push(node)
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
      nodeProps: { status: item.status, isEntry: true, entryPath: item.path },
    }))
  }, [collections, items, hiddenRootPath])

  // Initialize tree controller
  const tree = useTree({
    initialExpandedState: expandedStateRef?.current ?? {},
    onNodeExpand: (value) => {
      // Update local state synchronously
      localExpandedStateRef.current = {
        ...localExpandedStateRef.current,
        [value]: true,
      }
      // Notify parent immediately
      onExpandedStateChange?.(localExpandedStateRef.current)
    },
    onNodeCollapse: (value) => {
      // Update local state synchronously
      localExpandedStateRef.current = {
        ...localExpandedStateRef.current,
        [value]: false,
      }
      // Notify parent immediately
      onExpandedStateChange?.(localExpandedStateRef.current)
    },
  })

  // Forward tree controller to parent for collapse/expand all functionality
  useEffect(() => {
    onTreeControllerReady?.(tree)
  }, [onTreeControllerReady])

  // Cleanup: save current state when component unmounts
  // Empty dependency array ensures this only runs on mount/unmount, not on re-renders
  useEffect(() => {
    return () => {
      onExpandedStateChange?.(localExpandedStateRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Restore state on mount and when selectedPath changes
  useEffect(() => {
    if (!selectedPath || !treeData) return

    const savedState = expandedStateRef?.current ?? {}

    // Calculate path to current entry and merge with saved state
    const pathToEntry = calculatePathToEntry(selectedPath, treeData)
    const baseState = { ...savedState, ...pathToEntry }

    // Only update if state actually changed to avoid infinite loops
    const currentStateJson = JSON.stringify(tree.expandedState)
    const newStateJson = JSON.stringify(baseState)
    if (currentStateJson !== newStateJson) {
      tree.setExpandedState(baseState)
      localExpandedStateRef.current = baseState
      // Notify parent of the merged state
      onExpandedStateChange?.(baseState)
    }
    // Dependencies limited to data changes only to prevent infinite update loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, treeData])

  // Auto-scroll to selected entry when drawer opens
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

  // Reset scroll flag when component mounts (drawer opens)
  useEffect(() => {
    hasScrolledRef.current = false
  }, [])

  const Chevron = ({ expanded, visible }: { expanded: boolean; visible: boolean }) => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ opacity: visible ? 0.9 : 0 }}
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
    const onAdd = node.nodeProps?.onAdd as (() => void) | undefined
    const onEdit = node.nodeProps?.onEdit as (() => void) | undefined
    const onAddSubCollection = node.nodeProps?.onAddSubCollection as (() => void) | undefined
    const onDelete = node.nodeProps?.onDelete as (() => void) | undefined
    const entryPath = node.nodeProps?.entryPath as LogicalPath | undefined
    const contentId = node.nodeProps?.contentId as string | undefined
    const parentCollectionPath = node.nodeProps?.parentCollectionPath as LogicalPath | undefined
    const childIndex = node.nodeProps?.childIndex as number | undefined
    const totalChildrenCount = node.nodeProps?.totalChildrenCount as number | undefined
    const isCollection = node.nodeProps?.isCollection as boolean | undefined
    const isEntry = node.nodeProps?.isEntry as boolean | undefined
    const conflictNotice = node.nodeProps?.conflictNotice as boolean | undefined
    const isLeaf = !hasChildren || isEntry
    const selected = node.value === selectedPath

    // For collections, always show chevron (even if empty) to match standard tree UI
    // Mantine only provides hasChildren=true if children.length > 0, but we want
    // collections to always be expandable
    const showChevron = hasChildren || Boolean(isCollection)

    // Reordering is available for both entries and collections that have contentId and parent path
    const canReorder =
      onReorderEntry && contentId && parentCollectionPath && typeof childIndex === 'number'
    const canMoveUp = canReorder && childIndex > 0
    const canMoveDown =
      canReorder && typeof totalChildrenCount === 'number' && childIndex < totalChildrenCount - 1

    // Determine if we should show a context menu
    // Collections show menu for add/edit/delete actions OR for reordering (subcollections)
    const hasCollectionMenu =
      isCollection && (onAdd || onEdit || onAddSubCollection || onDelete || canReorder)
    const hasEntryMenu = isEntry && entryPath && (onDeleteEntry || onRenameEntry || onReorderEntry)

    return (
      <Box
        {...elementProps}
        ref={selected ? selectedNodeRef : undefined}
        data-testid={`entry-nav-item-${String(node.label ?? '')
          .toLowerCase()
          .replace(/\s+/g, '-')}`}
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
          backgroundColor: selected ? 'var(--mantine-color-brand-0)' : undefined,
          border: selected ? '1px solid var(--mantine-color-brand-3)' : '1px solid transparent',
          transition: 'background-color 120ms ease, border-color 120ms ease',
        }}
      >
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Group gap={6} wrap="nowrap">
            <Box
              w={18}
              h={18}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Chevron expanded={expanded} visible={showChevron} />
            </Box>
            <Text size="sm" fw={selected ? 600 : 500} truncate="end">
              {node.label}
            </Text>
            {status && (
              <Badge size="xs" variant="light" color="gray">
                {status}
              </Badge>
            )}
            {conflictNotice && (
              <Tooltip
                label="This content was updated on the base branch — a reviewer will reconcile"
                withArrow
              >
                <Badge size="xs" variant="light" color="orange" data-testid="conflict-badge">
                  conflict
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Group gap={4} wrap="nowrap">
            {hasCollectionMenu && (
              <Menu shadow="md" width={200} withinPortal position="bottom-end">
                <Menu.Target>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={(event) => event.stopPropagation()}
                    aria-label="Collection actions"
                    data-testid={`collection-menu-${String(node.label ?? '')
                      .toLowerCase()
                      .replace(/\s+/g, '-')}`}
                  >
                    <IconDots size={14} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {canReorder && (
                    <>
                      <Menu.Item
                        leftSection={<IconArrowUp size={14} />}
                        disabled={!canMoveUp}
                        onClick={(event) => {
                          event.stopPropagation()
                          onReorderEntry?.(parentCollectionPath!, contentId!, 'up')
                        }}
                      >
                        Move Up
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconArrowDown size={14} />}
                        disabled={!canMoveDown}
                        onClick={(event) => {
                          event.stopPropagation()
                          onReorderEntry?.(parentCollectionPath!, contentId!, 'down')
                        }}
                      >
                        Move Down
                      </Menu.Item>
                      {(onAdd || onAddSubCollection || onEdit || onDelete) && <Menu.Divider />}
                    </>
                  )}
                  {onAdd && (
                    <Menu.Item
                      leftSection={<IconPlus size={14} />}
                      onClick={(event) => {
                        event.stopPropagation()
                        onAdd()
                      }}
                      data-testid="add-entry-menu-item"
                    >
                      Add Entry
                    </Menu.Item>
                  )}
                  {onAddSubCollection && (
                    <Menu.Item
                      leftSection={<IconFolderPlus size={14} />}
                      onClick={(event) => {
                        event.stopPropagation()
                        onAddSubCollection()
                      }}
                    >
                      Add Sub-Collection
                    </Menu.Item>
                  )}
                  {(onAdd || onAddSubCollection) && (onEdit || onDelete) && <Menu.Divider />}
                  {onEdit && (
                    <Menu.Item
                      leftSection={<IconEdit size={14} />}
                      onClick={(event) => {
                        event.stopPropagation()
                        onEdit()
                      }}
                    >
                      Edit Collection
                    </Menu.Item>
                  )}
                  {onDelete && (
                    <Menu.Item
                      leftSection={<IconTrash size={14} />}
                      color="red"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDelete()
                      }}
                    >
                      Delete Collection
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
            {hasEntryMenu && (
              <Menu shadow="md" width={150} withinPortal position="bottom-end">
                <Menu.Target>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={(event) => event.stopPropagation()}
                    aria-label="Entry actions"
                    data-testid={`entry-menu-${String(node.label ?? '')
                      .toLowerCase()
                      .replace(/\s+/g, '-')}`}
                  >
                    <IconDots size={14} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {onReorderEntry && contentId && parentCollectionPath && (
                    <>
                      <Menu.Item
                        leftSection={<IconArrowUp size={14} />}
                        disabled={!canMoveUp}
                        onClick={(event) => {
                          event.stopPropagation()
                          onReorderEntry(parentCollectionPath, contentId, 'up')
                        }}
                      >
                        Move Up
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconArrowDown size={14} />}
                        disabled={!canMoveDown}
                        onClick={(event) => {
                          event.stopPropagation()
                          onReorderEntry(parentCollectionPath, contentId, 'down')
                        }}
                      >
                        Move Down
                      </Menu.Item>
                      {(onRenameEntry || onDeleteEntry) && <Menu.Divider />}
                    </>
                  )}
                  {onRenameEntry && (
                    <Menu.Item
                      leftSection={<IconEdit size={14} />}
                      onClick={(event) => {
                        event.stopPropagation()
                        onRenameEntry(entryPath)
                      }}
                      data-testid="rename-entry-menu-item"
                    >
                      Rename Entry
                    </Menu.Item>
                  )}
                  {onDeleteEntry && (
                    <Menu.Item
                      leftSection={<IconTrash size={14} />}
                      color="red"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDeleteEntry(entryPath)
                      }}
                      data-testid="delete-entry-menu-item"
                    >
                      Delete Entry
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        </Group>
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
      <ScrollArea type="auto" offsetScrollbars style={{ flex: 1 }}>
        {treeData.length === 0 ? (
          <Text size="xs" c="dimmed" py="sm">
            No content
          </Text>
        ) : (
          <Box py="sm">
            <Tree
              data={treeData}
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
