'use client'

import React, { useMemo, useRef, useEffect } from 'react'

import {
  Badge,
  Box,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tree,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
  rem,
} from '@mantine/core'

import { calculatePathToEntry } from './editor-utils'

// TreeController type from Mantine's useTree hook
type TreeController = ReturnType<typeof useTree>

export interface EntryNavItem {
  id: string
  label: string
  status?: string
  collectionId?: string
}

export interface EntryNavCollection {
  id: string
  label: string
  type: 'collection' | 'entry'
  entries?: EntryNavItem[]
  children?: EntryNavCollection[]
  onAdd?: () => void
}

export interface EntryNavigatorProps {
  items?: EntryNavItem[]
  collections?: EntryNavCollection[]
  selectedId?: string
  onSelect: (id: string) => void
  onTreeControllerReady?: (controller: TreeController) => void
  expandedStateRef?: React.MutableRefObject<Record<string, boolean>>
  onExpandedStateChange?: (state: Record<string, boolean>) => void
}

export const EntryNavigator: React.FC<EntryNavigatorProps> = ({
  items,
  collections,
  selectedId,
  onSelect,
  onTreeControllerReady,
  expandedStateRef,
  onExpandedStateChange,
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
            value: entry?.id ?? `collection:${col.id}`,
            label: entry?.label ?? col.label,
            nodeProps: { status: entry?.status, isEntry: true },
            children: [],
          }
        }
        const entryNodes =
          col.entries?.map((entry) => ({
            value: entry.id,
            label: entry.label,
            nodeProps: { status: entry.status, isEntry: true },
          })) ?? []
        const childNodes = col.children?.map(toTree) ?? []
        const allChildren = [...entryNodes, ...childNodes]

        // Collections should always have children array (even if empty) to show chevron
        // This matches standard file tree UI behavior where folders always show expand/collapse
        return {
          value: `collection:${col.id}`,
          label: col.label,
          nodeProps: { isCollection: true, type: col.type, onAdd: col.onAdd },
          children: allChildren,
        }
      }
      return collections.map(toTree)
    }

    const flatItems = items ?? []
    return flatItems.map((item) => ({
      value: item.id,
      label: item.label,
      nodeProps: { status: item.status, isEntry: true },
    }))
  }, [collections, items])

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

  // Restore state on mount and when selectedId changes
  useEffect(() => {
    if (!selectedId || !treeData) return

    const savedState = expandedStateRef?.current ?? {}

    // Calculate path to current entry and merge with saved state
    const pathToEntry = calculatePathToEntry(selectedId, treeData)
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
  }, [selectedId, treeData])

  // Auto-scroll to selected entry when drawer opens
  useEffect(() => {
    if (selectedId && selectedNodeRef.current && !hasScrolledRef.current) {
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
  }, [selectedId, tree.expandedState])

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
    const isCollection = node.nodeProps?.isCollection as boolean | undefined
    const isLeaf = !hasChildren || node.nodeProps?.isEntry
    const selected = node.value === selectedId

    // For collections, always show chevron (even if empty) to match standard tree UI
    // Mantine only provides hasChildren=true if children.length > 0, but we want
    // collections to always be expandable
    const showChevron = hasChildren || Boolean(isCollection)

    return (
      <Box
        {...elementProps}
        ref={selected ? selectedNodeRef : undefined}
        data-testid={`entry-nav-item-${String(node.label ?? '')
          .toLowerCase()
          .replace(/\s+/g, '-')}`}
        onClick={(event) => {
          elementProps.onClick(event)
          if (isLeaf && node.nodeProps?.isEntry) {
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
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
          </Group>
          {isCollection && onAdd && expanded ? (
            <Button
              size="compact-xs"
              variant="light"
              color="accent"
              onClick={(event) => {
                event.stopPropagation()
                onAdd()
              }}
            >
              + Add
            </Button>
          ) : null}
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
