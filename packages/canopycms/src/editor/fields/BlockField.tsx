'use client'

import React, { useId, useRef, useState } from 'react'

import {
  ActionIcon,
  Box,
  Button,
  Group,
  Menu,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'

import type { BlockConfig, FieldConfig } from '../../config'
import { isPlainRecord } from '../../validation/field-traversal'
import { formatCanopyPath } from '../canopy-path'
import { useFieldCommentControl } from '../comments/field-comment-context'
import { ExpandAllButton } from './ExpandAllButton'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'
import { ItemList } from './ItemList'
import { useItemExpansion } from './item-expansion'
import { useListItemKeys } from './list-item-keys'
import { listItemSecondary } from './list-item-title'

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
  /** No add, remove, reorder or drag; rows still collapse. */
  readOnly?: boolean
  /** Names the entry being edited; another entry starts with the default rows open. */
  resetKey?: string
  /** True when a field inside block `index` has a validation error. */
  hasErrors?: (index: number) => boolean
  /** Told of each block Remove takes out, so the caller can offer Undo. */
  onRemoved?: (index: number, block: BlockInstance) => void
}

const findTemplate = (templates: BlockConfig[], name: string) =>
  templates.find((t) => t.name === name)

const ADD_SECTION = 'Add section'

/**
 * The block templates as a menu, each with its description, so an editor picks a section by
 * what it is for. `target` is the control that opens it.
 */
const TemplateMenu: React.FC<{
  templates: BlockConfig[]
  onPick: (templateName: string) => void
  onOpenChange?: (opened: boolean) => void
  target: React.ReactNode
}> = ({ templates, onPick, onOpenChange, target }) => (
  <Menu position="bottom-start" withinPortal shadow="md" width={320} onChange={onOpenChange}>
    {target}
    <Menu.Dropdown data-testid="block-template-menu">
      <ScrollArea.Autosize mah={360} type="auto">
        {templates.map((template) => (
          <Menu.Item
            key={template.name}
            onClick={() => onPick(template.name)}
            data-testid={`block-template-${template.name}`}
          >
            <Text size="sm" fw={500}>
              {template.label ?? template.name}
            </Text>
            {template.description && (
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'normal' }}>
                {template.description}
              </Text>
            )}
          </Menu.Item>
        ))}
      </ScrollArea.Autosize>
    </Menu.Dropdown>
  </Menu>
)

/**
 * The gap between two blocks. Its add control shows while the gap is hovered or the control is
 * focused, and stays in the tab order, so a keyboard reaches it between the two blocks.
 */
const InsertBetween: React.FC<{
  templates: BlockConfig[]
  onPick: (templateName: string) => void
}> = ({ templates, onPick }) => {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [opened, setOpened] = useState(false)
  const shown = hovered || focused || opened
  return (
    <Box
      h={20}
      pos="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid="block-insert-between"
    >
      <Box
        aria-hidden
        pos="absolute"
        left={0}
        right={0}
        top="50%"
        h={2}
        bg="blue.4"
        style={{ opacity: shown ? 1 : 0, transition: 'opacity 120ms ease' }}
      />
      <Group justify="center" h="100%" style={{ position: 'relative' }}>
        <TemplateMenu
          templates={templates}
          onPick={onPick}
          onOpenChange={setOpened}
          target={
            <Tooltip label="Add section here" openDelay={300}>
              <Menu.Target>
                <ActionIcon
                  size="sm"
                  radius="xl"
                  variant="default"
                  aria-label="Add section here"
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  style={{ opacity: shown ? 1 : 0, transition: 'opacity 120ms ease' }}
                >
                  <IconPlus size={14} aria-hidden />
                </ActionIcon>
              </Menu.Target>
            </Tooltip>
          }
        />
      </Group>
    </Box>
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
  resetKey = '',
  hasErrors,
  onRemoved,
}) => {
  const descriptionBaseId = useId()
  const commentControl = useFieldCommentControl(dataCanopyField ?? formatCanopyPath(path))
  const keysFor = useListItemKeys()
  const itemKeys = keysFor(value, 'blocks')
  const expansion = useItemExpansion(itemKeys, resetKey)
  const focusAfterRenderRef = useRef<number | null>(null)

  const emit = (next: BlockInstance[]) => {
    if (!readOnly) onChange(next)
  }

  const insertAt = (index: number, block: BlockInstance) => {
    focusAfterRenderRef.current = index
    emit([...value.slice(0, index), block, ...value.slice(index)])
  }

  const addAt = (index: number) => (templateName: string) => {
    if (findTemplate(templates, templateName))
      insertAt(index, { template: templateName, value: {} })
  }

  const updateBlockValue = (index: number, val: Record<string, unknown>) => {
    const next = [...value]
    next[index] = { ...next[index], value: val }
    emit(next)
  }

  return (
    <Paper
      withBorder
      p="md"
      bg="gray.0"
      data-canopy-field={dataCanopyField ?? formatCanopyPath(path)}
      role="group"
      aria-label={label ?? 'Blocks'}
      data-removal-focus
      tabIndex={-1}
      shadow="xs"
      {...groupDescriptionProps(descriptionBaseId, description)}
    >
      <Stack gap="sm">
        <FieldLabel
          label={label ?? 'Blocks'}
          required={required}
          description={description}
          descriptionBaseId={descriptionBaseId}
          commentControl={commentControl}
          actions={value.length > 1 && <ExpandAllButton expansion={expansion} />}
        />

        <ItemList
          items={value}
          itemKeys={itemKeys}
          path={path}
          readOnly={readOnly}
          expansion={expansion}
          focusAfterRenderRef={focusAfterRenderRef}
          hasErrors={hasErrors}
          summarize={(block) => {
            const template = findTemplate(templates, block.template)
            return {
              title: template?.label ?? block.template ?? 'Unknown block',
              secondary: template ? listItemSecondary(block.value, template.fields) : undefined,
            }
          }}
          describe={(block) => findTemplate(templates, block.template)?.description}
          onMove={(from, to) => {
            if (from === to || to < 0 || to >= value.length) return
            const next = [...value]
            const [moved] = next.splice(from, 1)
            next.splice(to, 0, moved)
            emit(next)
          }}
          onDuplicate={(idx) =>
            // Focus stays on the row's menu, which stands in for the item that acted.
            emit([...value.slice(0, idx + 1), structuredClone(value[idx]), ...value.slice(idx + 1)])
          }
          onRemove={(idx) => {
            if (readOnly) return
            const block = value[idx]
            emit(value.filter((_, i) => i !== idx))
            onRemoved?.(idx, block)
          }}
          renderBetween={
            readOnly
              ? undefined
              : (idx) => <InsertBetween templates={templates} onPick={addAt(idx)} />
          }
          renderItem={(block, idx) => {
            const template = findTemplate(templates, block.template)
            const currentPath = [...path, idx]
            if (!template) {
              return (
                <Text size="sm" c="red.8">
                  No template found for &quot;{block.template}&quot;
                </Text>
              )
            }
            return template.fields.map((f: FieldConfig) => (
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
            ))
          }}
        />

        {value.length === 0 && (
          <Text size="sm" c="dimmed">
            {readOnly ? 'No sections.' : 'No sections yet.'}
          </Text>
        )}

        {!readOnly && (
          <Group>
            <TemplateMenu
              templates={templates}
              onPick={addAt(value.length)}
              target={
                <Menu.Target>
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<IconPlus size={14} aria-hidden />}
                    data-testid="block-add-section"
                  >
                    {ADD_SECTION}
                  </Button>
                </Menu.Target>
              }
            />
          </Group>
        )}
      </Stack>
    </Paper>
  )
}
