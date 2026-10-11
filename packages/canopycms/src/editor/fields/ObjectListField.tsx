import React from 'react'

import { Button, Paper, Stack, Text } from '@mantine/core'

import type { ObjectFieldConfig } from '../../config'
import { isPlainRecord } from '../../validation/field-traversal'
import { formatCanopyPath } from '../canopy-path'
import { useFieldCommentControl } from '../comments/field-comment-context'
import { EDITOR_ACTIONS } from '../copy'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'
import { listItemHeading } from './list-item-title'
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
  /** Called after Remove takes item `index` out, so the caller can offer Undo. */
  onRemoved?: (index: number, item: Record<string, unknown>) => void
}

/**
 * A `list: true` object field: one card per item, titled from the item's content, holding the
 * item's fields directly rather than in a second card.
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
  onRemoved,
}) => {
  const commentControl = useFieldCommentControl(canopyPath)

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
          actions={
            !readOnly && (
              <Button variant="light" onClick={() => onChange([...items, {}])}>
                Add item
              </Button>
            )
          }
        />
        <Stack gap="sm">
          {items.map((item, idx) => {
            const heading = listItemHeading(item, field, idx)
            const itemPath = [...path, idx]
            const current = isPlainRecord(item) ? item : {}
            return (
              <Paper
                key={itemKeys[idx]}
                role="group"
                aria-label={heading}
                withBorder
                p="sm"
                shadow="xs"
                data-canopy-field={formatCanopyPath(itemPath)}
                data-testid="object-list-item"
              >
                <Stack gap="sm">
                  <FieldLabel
                    label={heading}
                    actions={
                      !readOnly && (
                        <Button
                          variant="subtle"
                          color="red"
                          onClick={(event) => {
                            // The row goes, so focus moves to its list, not the page.
                            const list =
                              event.currentTarget.closest<HTMLElement>('[data-removal-focus]')
                            onChange(items.filter((_, i) => i !== idx))
                            list?.focus()
                            onRemoved?.(idx, item)
                          }}
                        >
                          {EDITOR_ACTIONS.remove}
                        </Button>
                      )
                    }
                  />
                  {field.fields.map((child) => {
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
                  })}
                </Stack>
              </Paper>
            )
          })}
          {items.length === 0 && (
            <Text size="xs" c="dimmed">
              {readOnly ? 'No items.' : 'No items yet. Add one to get started.'}
            </Text>
          )}
        </Stack>
      </Stack>
    </Paper>
  )
}
