'use client'

import React, { useEffect, useId, useRef, useState } from 'react'

import {
  ActionIcon,
  Box,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core'
import {
  DndContext,
  type Announcements,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { IconAlertCircle, IconChevronRight, IconDots, IconGripVertical } from '@tabler/icons-react'

import { formatCanopyPath } from '../canopy-path'
import { EDITOR_ACTIONS } from '../copy'
import { ReasonedMenuItem } from '../components/ReasonedMenuItem'
import { REVEAL_FIELD_EVENT, focusFieldTarget } from '../field-target'
import { FieldDescription, fieldDescriptionId } from './FieldDescription'
import type { ItemExpansion } from './item-expansion'

/** What a collapsed row shows: its title, and a second value from its content. */
interface ItemSummary {
  title: string
  secondary?: string
}

export interface ItemListProps<T> {
  items: readonly T[]
  /** One stable key per item, from `useListItemKeys`. */
  itemKeys: readonly string[]
  /** The list field's own path; row `i` is `[...path, i]`. */
  path: Array<string | number>
  readOnly: boolean
  expansion: ItemExpansion
  summarize: (item: T, index: number) => ItemSummary
  renderItem: (item: T, index: number) => React.ReactNode
  /** Guidance shown at the top of an open row, which the row's group is described by. */
  describe?: (item: T) => string | undefined
  /** True when a field inside row `index` has a validation error. */
  hasErrors?: (index: number) => boolean
  onMove: (from: number, to: number) => void
  onDuplicate: (index: number) => void
  /** Takes row `index` out; focus has already moved to the list. */
  onRemove: (index: number) => void
  /** Rendered between rows `index - 1` and `index`, such as a block list's insert-here control. */
  renderBetween?: (index: number) => React.ReactNode
  /**
   * A row index to focus after the next render, set by the caller just before it adds a row.
   * Cleared once used.
   */
  focusAfterRenderRef?: React.MutableRefObject<number | null>
  'data-testid'?: string
}

const ROW_GAP = 8

/**
 * The rows of an object list or block list: each collapses to a one-line summary and carries a
 * drag handle (pointer and keyboard, via dnd-kit) and a "…" menu with Move up, Move down,
 * Duplicate and Remove. A read-only list keeps only collapsing. A collapsed row stays mounted
 * and opens when something asks to reveal a field inside it (`REVEAL_FIELD_EVENT`).
 */
export function ItemList<T>({
  items,
  itemKeys,
  path,
  readOnly,
  expansion,
  summarize,
  renderItem,
  describe,
  hasErrors,
  onMove,
  onDuplicate,
  onRemove,
  renderBetween,
  focusAfterRenderRef,
  'data-testid': testId,
}: ItemListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  const [announcement, setAnnouncement] = useState('')

  // Constant: DndContext's hooks depend on the sensor count; read-only disables each row instead.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    const index = focusAfterRenderRef?.current
    if (index === null || index === undefined || !focusAfterRenderRef) return
    focusAfterRenderRef.current = null
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-item-row]') ?? [])].find(
      (el) => el.dataset.itemRow === itemKeys[index],
    )
    if (row) focusFieldTarget(row)
  })

  const titleAt = (index: number) => summarize(items[index], index).title
  const indexOf = (id: UniqueIdentifier) => itemKeys.indexOf(String(id))
  const position = (index: number) => `position ${index + 1} of ${items.length}`

  // dnd-kit's defaults read out the internal row keys; these use the rows' titles.
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${titleAt(indexOf(active.id))}, ${position(indexOf(active.id))}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${titleAt(indexOf(active.id))} is over ${position(indexOf(over.id))}.`
        : `${titleAt(indexOf(active.id))} is not over a position.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${titleAt(indexOf(active.id))} moved to ${position(indexOf(over.id))}.`
        : `${titleAt(indexOf(active.id))} dropped.`,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. ${titleAt(indexOf(active.id))} is back at ${position(indexOf(active.id))}.`,
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = indexOf(active.id)
    const to = indexOf(over.id)
    if (from !== -1 && to !== -1) onMove(from, to)
  }

  const move = (from: number, to: number) => {
    onMove(from, to)
    setAnnouncement(`${titleAt(from)} moved to ${position(to)}.`)
  }

  const duplicate = (index: number) => {
    onDuplicate(index)
    setAnnouncement(`${titleAt(index)} duplicated, position ${index + 2} of ${items.length + 1}.`)
  }

  const remove = (index: number) => {
    // The row goes, so focus moves to its list, not the page.
    listRef.current?.closest<HTMLElement>('[data-removal-focus]')?.focus()
    onRemove(index)
  }

  return (
    <div ref={listRef} data-testid={testId}>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd} accessibility={{ announcements }}>
        <SortableContext items={[...itemKeys]} strategy={verticalListSortingStrategy}>
          {items.map((item, idx) => {
            const key = itemKeys[idx]
            const summary = summarize(item, idx)
            return (
              <React.Fragment key={key}>
                {idx > 0 && (renderBetween ? renderBetween(idx) : <Box h={ROW_GAP} aria-hidden />)}
                <ItemRow
                  rowKey={key}
                  canopyPath={formatCanopyPath([...path, idx])}
                  summary={summary}
                  description={describe?.(item)}
                  hasErrors={hasErrors?.(idx) ?? false}
                  expanded={expansion.isExpanded(key)}
                  onExpandedChange={(open) => expansion.setExpanded(key, open)}
                  readOnly={readOnly}
                  isFirst={idx === 0}
                  isLast={idx === items.length - 1}
                  onMoveUp={() => move(idx, idx - 1)}
                  onMoveDown={() => move(idx, idx + 1)}
                  onDuplicate={() => duplicate(idx)}
                  onRemove={() => remove(idx)}
                >
                  {renderItem(item, idx)}
                </ItemRow>
              </React.Fragment>
            )
          })}
        </SortableContext>
      </DndContext>
      <VisuallyHidden aria-live="polite">{announcement}</VisuallyHidden>
    </div>
  )
}

interface ItemRowProps {
  rowKey: string
  canopyPath: string
  summary: ItemSummary
  description?: string
  hasErrors: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  readOnly: boolean
  isFirst: boolean
  isLast: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onDuplicate: () => void
  onRemove: () => void
  children: React.ReactNode
}

const ItemRow: React.FC<ItemRowProps> = ({
  rowKey,
  canopyPath,
  summary,
  description,
  hasErrors,
  expanded,
  onExpandedChange,
  readOnly,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onRemove,
  children,
}) => {
  const baseId = useId()
  const bodyId = `${baseId}-body`
  const rowRef = useRef<HTMLDivElement | null>(null)
  const menuTargetRef = useRef<HTMLButtonElement>(null)
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rowKey, disabled: readOnly })

  const expandedRef = useRef(expanded)
  const onExpandedChangeRef = useRef(onExpandedChange)
  useEffect(() => {
    expandedRef.current = expanded
    onExpandedChangeRef.current = onExpandedChange
  })
  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const reveal = (event: Event) => {
      if (expandedRef.current) return
      event.preventDefault()
      onExpandedChangeRef.current(true)
    }
    row.addEventListener(REVEAL_FIELD_EVENT, reveal)
    return () => row.removeEventListener(REVEAL_FIELD_EVENT, reveal)
  }, [])

  // A menu item is gone once it acts, so focus returns to the menu's trigger, which moves with
  // the row.
  const thenFocusMenu = (act: () => void) => () => {
    act()
    requestAnimationFrame(() => menuTargetRef.current?.focus())
  }

  const actionsLabel = `Actions for ${summary.title}`

  return (
    <Paper
      ref={(node: HTMLDivElement | null) => {
        rowRef.current = node
        setNodeRef(node)
      }}
      withBorder
      shadow="xs"
      role="group"
      aria-label={summary.title}
      aria-describedby={expanded && description ? fieldDescriptionId(baseId) : undefined}
      data-canopy-field={canopyPath}
      data-item-row={rowKey}
      data-testid="item-row"
      data-expanded={expanded || undefined}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 1 : undefined,
        boxShadow: isDragging ? 'var(--mantine-shadow-md)' : undefined,
      }}
    >
      <Group gap={4} wrap="nowrap" px={6} py={4} align="center">
        {!readOnly && (
          <Tooltip label="Drag to reorder" openDelay={500}>
            <ActionIcon
              ref={setActivatorNodeRef}
              variant="subtle"
              color="gray"
              aria-label="Drag to reorder"
              {...attributes}
              {...listeners}
              style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
            >
              <IconGripVertical size={16} aria-hidden />
            </ActionIcon>
          </Tooltip>
        )}
        <UnstyledButton
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onExpandedChange(!expanded)}
          data-testid="item-row-toggle"
          style={{ flex: 1, minWidth: 0, borderRadius: 'var(--mantine-radius-sm)' }}
          px={4}
          py={4}
        >
          <Group gap={6} wrap="nowrap">
            <IconChevronRight
              size={16}
              aria-hidden
              style={{
                flexShrink: 0,
                transform: expanded ? 'rotate(90deg)' : undefined,
                transition: 'transform 120ms ease',
              }}
            />
            <Text
              size="sm"
              fw={500}
              truncate="end"
              style={summary.secondary ? { flexShrink: 0, maxWidth: '60%' } : { minWidth: 0 }}
            >
              {summary.title}
            </Text>
            {summary.secondary && (
              <Text size="sm" c="dimmed" truncate="end" style={{ minWidth: 0 }}>
                {summary.secondary}
              </Text>
            )}
            {hasErrors && !expanded && (
              <Group gap={2} wrap="nowrap" ml="auto" style={{ flexShrink: 0 }}>
                <IconAlertCircle size={14} color="var(--mantine-color-red-8)" aria-hidden />
                <Text size="xs" c="red.8">
                  Has errors
                </Text>
              </Group>
            )}
          </Group>
        </UnstyledButton>
        {!readOnly && (
          <Menu position="bottom-end" withinPortal shadow="sm" width={220}>
            <Tooltip label={actionsLabel} openDelay={500}>
              <Menu.Target>
                <ActionIcon
                  ref={menuTargetRef}
                  variant="subtle"
                  color="gray"
                  aria-label={actionsLabel}
                  data-testid="item-row-menu"
                >
                  <IconDots size={16} aria-hidden />
                </ActionIcon>
              </Menu.Target>
            </Tooltip>
            <Menu.Dropdown>
              <ReasonedMenuItem
                blockedReason={isFirst ? 'Already first' : undefined}
                onClick={thenFocusMenu(onMoveUp)}
                data-testid="item-row-move-up"
              >
                Move up
              </ReasonedMenuItem>
              <ReasonedMenuItem
                blockedReason={isLast ? 'Already last' : undefined}
                onClick={thenFocusMenu(onMoveDown)}
                data-testid="item-row-move-down"
              >
                Move down
              </ReasonedMenuItem>
              <Menu.Item onClick={thenFocusMenu(onDuplicate)} data-testid="item-row-duplicate">
                Duplicate
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red.8" onClick={onRemove} data-testid="item-row-remove">
                {EDITOR_ACTIONS.remove}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <Box id={bodyId} hidden={!expanded}>
        <Stack gap="sm" px="sm" pb="sm" pt={4}>
          {description && <FieldDescription baseId={baseId} description={description} />}
          {children}
        </Stack>
      </Box>
    </Paper>
  )
}
