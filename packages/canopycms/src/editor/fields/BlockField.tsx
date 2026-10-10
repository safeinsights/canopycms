'use client'

import React, { useId, useMemo, useState } from 'react'

let blockKeyCounter = 0

import { ActionIcon, Button, Group, Paper, Select, Stack, Text } from '@mantine/core'
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import type { BlockConfig, FieldConfig } from '../../config'
import { isPlainRecord } from '../../validation/field-traversal'
import { formatCanopyPath } from '../canopy-path'
import { EDITOR_ACTIONS } from '../copy'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'

export interface BlockInstance {
  template: string
  value: Record<string, unknown>
}

type RenderField = (
  field: FieldConfig,
  value: unknown,
  onChange: (v: unknown) => void,
  path: Array<string | number>,
) => React.ReactNode

export interface BlockFieldProps {
  label?: string
  required?: boolean
  description?: string
  templates: BlockConfig[]
  value: BlockInstance[]
  onChange: (blocks: BlockInstance[]) => void
  renderField: RenderField
  path: Array<string | number>
  dataCanopyField?: string
  /** No add, remove, reorder or drag. */
  readOnly?: boolean
}

const findTemplate = (templates: BlockConfig[], name: string) =>
  templates.find((t) => t.name === name)

const SortableBlock: React.FC<{
  id: string
  /** The block's own path (`blocks[2]`), which preview focus lands on for the block as a whole. */
  canopyPath: string
  readOnly: boolean
  children: React.ReactNode
}> = ({ id, canopyPath, readOnly, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: readOnly,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  }

  return (
    <Paper
      ref={setNodeRef}
      withBorder
      p="sm"
      shadow="xs"
      style={style}
      data-canopy-field={canopyPath}
    >
      <Group align="flex-start" gap="sm">
        {!readOnly && (
          <ActionIcon
            size="md"
            key="drag-handle"
            variant="subtle"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
            style={{ cursor: 'grab' }}
          >
            ⇅
          </ActionIcon>
        )}
        <div key="content" style={{ flex: 1, minWidth: 0, width: '100%' }}>
          {children}
        </div>
      </Group>
    </Paper>
  )
}

export const BlockField: React.FC<BlockFieldProps> = ({
  label,
  required,
  description,
  templates,
  value,
  onChange,
  renderField,
  path,
  dataCanopyField,
  readOnly = false,
}) => {
  const descriptionBaseId = useId()
  const [itemKeys, setItemKeys] = useState<string[]>(() =>
    value.map(() => `block-${blockKeyCounter++}`),
  )
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null)

  // Keeps itemKeys in sync with value's length; setState runs directly in render, not an effect.
  if (value.length > itemKeys.length) {
    const extras = Array.from(
      { length: value.length - itemKeys.length },
      () => `block-${blockKeyCounter++}`,
    )
    setItemKeys((prev) => [...prev, ...extras])
  } else if (value.length < itemKeys.length) {
    setItemKeys((prev) => prev.slice(0, value.length))
  }

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
  // Fixed arity: useSensors memoises on its arguments, and a changing count never re-memoises.
  const sensors = useSensors(readOnly ? null : pointerSensor, readOnly ? null : keyboardSensor)

  const emit = (next: BlockInstance[]) => {
    if (!readOnly) onChange(next)
  }

  const addBlock = (templateName: string) => {
    const template = findTemplate(templates, templateName)
    if (!template) return
    if (readOnly) return
    emit([...value, { template: templateName, value: {} }])
    setItemKeys((prev) => [
      ...prev,
      `block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ])
  }

  const moveBlock = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= value.length || to >= value.length) return
    if (readOnly) return
    emit(arrayMove(value, from, to))
    setItemKeys((prev) => arrayMove(prev, from, to))
  }

  const removeBlock = (index: number) => {
    if (readOnly) return
    emit(value.filter((_, idx) => idx !== index))
    setItemKeys((prev) => prev.filter((_, idx) => idx !== index))
  }

  const updateBlockValue = (index: number, val: Record<string, unknown>) => {
    const next = [...value]
    next[index] = { ...next[index], value: val }
    emit(next)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = itemKeys.indexOf(String(active.id))
    const newIndex = itemKeys.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1) return
    moveBlock(oldIndex, newIndex)
  }

  const selectableTemplates = useMemo(
    () => templates.map((t) => ({ value: t.name, label: t.label ?? t.name })),
    [templates],
  )

  return (
    <Paper
      withBorder
      p="md"
      bg="gray.0"
      data-canopy-field={dataCanopyField ?? formatCanopyPath(path)}
      shadow="xs"
      {...groupDescriptionProps(descriptionBaseId, description)}
    >
      <Stack gap="sm">
        <FieldLabel
          label={label ?? 'Blocks'}
          required={required}
          description={description}
          descriptionBaseId={descriptionBaseId}
          actions={
            !readOnly && (
              <Select
                aria-label="Add block"
                placeholder="Add block..."
                data={selectableTemplates}
                value={pendingTemplate}
                onChange={(next) => {
                  if (next) {
                    addBlock(next)
                  }
                  setPendingTemplate(null)
                }}
                allowDeselect
                size="xs"
                w={180}
              />
            )
          }
        />

        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={itemKeys} strategy={verticalListSortingStrategy}>
            <Stack gap="sm">
              {value.map((block, idx) => {
                const template = findTemplate(templates, block.template)
                const currentPath = [...path, idx]

                return (
                  <SortableBlock
                    key={itemKeys[idx]}
                    id={itemKeys[idx]}
                    canopyPath={formatCanopyPath(currentPath)}
                    readOnly={readOnly}
                  >
                    <Stack gap="xs">
                      <FieldLabel
                        label={template?.label ?? block.template ?? 'Unknown block'}
                        actions={
                          !readOnly && (
                            <>
                              <ActionIcon
                                size="md"
                                variant="light"
                                aria-label="Move block up"
                                disabled={idx === 0}
                                onClick={() => moveBlock(idx, idx - 1)}
                              >
                                ↑
                              </ActionIcon>
                              <ActionIcon
                                size="md"
                                variant="light"
                                aria-label="Move block down"
                                disabled={idx === value.length - 1}
                                onClick={() => moveBlock(idx, idx + 1)}
                              >
                                ↓
                              </ActionIcon>
                              <Button variant="subtle" color="red" onClick={() => removeBlock(idx)}>
                                {EDITOR_ACTIONS.remove}
                              </Button>
                            </>
                          )
                        }
                      />

                      {template ? (
                        <Stack gap="sm">
                          {template.fields.map((f: FieldConfig) => (
                            <React.Fragment key={f.name}>
                              {renderField(
                                f,
                                block.value?.[f.name],
                                (next) =>
                                  updateBlockValue(idx, {
                                    ...(isPlainRecord(block.value) ? block.value : {}),
                                    [f.name]: next,
                                  }),
                                [...currentPath, f.name],
                              )}
                            </React.Fragment>
                          ))}
                        </Stack>
                      ) : (
                        <Text size="xs" c="red">
                          No template found for &quot;{block.template}&quot;
                        </Text>
                      )}
                    </Stack>
                  </SortableBlock>
                )
              })}
            </Stack>
          </SortableContext>
        </DndContext>
      </Stack>
    </Paper>
  )
}
