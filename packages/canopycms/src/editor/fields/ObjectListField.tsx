import React, { useRef } from 'react'

import { Button, Group, Paper, Stack, Text } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'

import type { ObjectFieldConfig } from '../../config'
import { isPlainRecord } from '../../validation/field-traversal'
import { ITEM_KEY, mintItemKey, withFreshItemKeys } from '../../item-keys'
import { formatCanopyPath } from '../canopy-path'
import { useFieldCommentControl } from '../comments/field-comment-context'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'
import { ExpandAllButton } from './ExpandAllButton'
import { ItemList } from './ItemList'
import { useItemExpansion } from './item-expansion'
import { listItemSummary } from './list-item-title'
import type { RenderField } from './ObjectField'

export interface ObjectListFieldProps {
  /** Base for the description's id. */
  id: string
  label: string
  field: ObjectFieldConfig
  items: Record<string, unknown>[]
  /** One stable React key per item, from `useListItemKeys`. */
  itemKeys: string[]
  onChange: (next: Record<string, unknown>[]) => void
  renderField: RenderField
  path: Array<string | number>
  /** The list's canopy path, which picks its comment control. */
  canopyPath: string
  readOnly: boolean
  /** Names the entry being edited; another entry starts with the default rows open. */
  resetKey: string
  /** True when a field inside item `index` has a validation error. */
  hasErrors?: (index: number) => boolean
  /** Called after Remove takes item `index` out, so the caller can offer Undo. */
  onRemoved?: (index: number, item: Record<string, unknown>) => void
}

/**
 * A `list: true` object field: one collapsible row per item, titled from the item's content,
 * holding the item's fields directly rather than in a second card.
 */
export const ObjectListField: React.FC<ObjectListFieldProps> = ({
  id,
  label,
  field,
  items,
  itemKeys,
  onChange,
  renderField,
  path,
  canopyPath,
  readOnly,
  resetKey,
  hasErrors,
  onRemoved,
}) => {
  const commentControl = useFieldCommentControl(canopyPath)
  const expansion = useItemExpansion(itemKeys, resetKey)
  const focusAfterRenderRef = useRef<number | null>(null)

  const insertAt = (index: number, item: Record<string, unknown>) => {
    focusAfterRenderRef.current = index
    onChange([...items.slice(0, index), item, ...items.slice(index)])
  }

  return (
    <Paper
      withBorder
      p="md"
      shadow="xs"
      {...groupDescriptionProps(id, field.description)}
      role="group"
      aria-label={label}
      data-removal-focus
      tabIndex={-1}
    >
      <Stack gap="sm">
        <FieldLabel
          label={label}
          required={field.required}
          description={field.description}
          descriptionBaseId={id}
          commentControl={commentControl}
          actions={items.length > 1 && <ExpandAllButton expansion={expansion} />}
        />
        <ItemList
          items={items}
          itemKeys={itemKeys}
          path={path}
          readOnly={readOnly}
          expansion={expansion}
          summarize={(item, idx) => listItemSummary(item, field, idx)}
          hasErrors={hasErrors}
          focusAfterRenderRef={focusAfterRenderRef}
          onMove={(from, to) => {
            if (from === to || to < 0 || to >= items.length) return
            const next = [...items]
            const [moved] = next.splice(from, 1)
            next.splice(to, 0, moved)
            onChange(next)
          }}
          onDuplicate={(idx) =>
            // Focus stays on the row's menu, which stands in for the item that acted. The copy
            // gets new keys, so no comment thread follows it.
            onChange([
              ...items.slice(0, idx + 1),
              withFreshItemKeys(field, structuredClone(items[idx])),
              ...items.slice(idx + 1),
            ])
          }
          onRemove={(idx) => {
            const item = items[idx]
            onChange(items.filter((_, i) => i !== idx))
            onRemoved?.(idx, item)
          }}
          renderItem={(item, idx) => {
            const itemPath = [...path, idx]
            const current = isPlainRecord(item) ? item : {}
            return field.fields.map((child) => {
              const childPath = [...itemPath, child.name]
              return (
                <div key={formatCanopyPath(childPath)}>
                  {renderField(
                    child,
                    current[child.name],
                    (next) => {
                      const nextItems = [...items]
                      nextItems[idx] = { ...current, [child.name]: next }
                      onChange(nextItems)
                    },
                    childPath,
                  )}
                </div>
              )
            })
          }}
        />
        {items.length === 0 && (
          <Text size="sm" c="dimmed">
            {readOnly ? 'Nothing added.' : 'Nothing added yet.'}
          </Text>
        )}
        {!readOnly && (
          <Group>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconPlus size={14} aria-hidden />}
              onClick={() => insertAt(items.length, { [ITEM_KEY]: mintItemKey() })}
              data-testid="object-list-add"
            >
              Add {field.itemLabel ?? 'item'}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  )
}
