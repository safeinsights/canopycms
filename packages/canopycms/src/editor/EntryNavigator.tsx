'use client'

import React, { useMemo } from 'react'

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
  type RenderTreeNodePayload,
  type TreeNodeData,
  rem,
} from '@mantine/core'

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
}

export const EntryNavigator: React.FC<EntryNavigatorProps> = ({
  items,
  collections,
  selectedId,
  onSelect,
}) => {
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
        return {
          value: `collection:${col.id}`,
          label: col.label,
          nodeProps: { onAdd: col.onAdd, isCollection: true, type: col.type },
          children: [...entryNodes, ...childNodes],
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
    const isLeaf = !hasChildren || node.nodeProps?.isEntry
    const selected = node.value === selectedId

    return (
      <Box
        {...elementProps}
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
              <Chevron expanded={expanded} visible={hasChildren} />
            </Box>
            <Text size="sm" fw={selected ? 600 : 500} truncate="end">
              {node.label}
            </Text>
            {status ? (
              <Badge size="xs" variant="light" color="neutral">
                {status}
              </Badge>
            ) : null}
          </Group>
          {hasChildren && onAdd ? (
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
            <Tree data={treeData} renderNode={renderNode} selectOnClick={false} levelOffset="sm" />
          </Box>
        )}
      </ScrollArea>
    </Stack>
  )
}

export default EntryNavigator
