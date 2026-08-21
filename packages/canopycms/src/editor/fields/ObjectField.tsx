import React from 'react'

import { Button, Group, Paper, Stack, Text } from '@mantine/core'

import type { FieldConfig } from '../../config'
import { formatCanopyPath } from '../canopy-path'

export type RenderField = (
  field: FieldConfig,
  value: unknown,
  onChange: (v: unknown) => void,
  path: Array<string | number>,
) => React.ReactNode

export interface ObjectFieldProps {
  label?: string
  fields: FieldConfig[]
  value: Record<string, unknown> | undefined
  onChange: (value: Record<string, unknown>) => void
  renderField: RenderField
  path: Array<string | number>
  dataCanopyField?: string
  /**
   * When provided, renders a "Clear" affordance next to the label that
   * resets this object field back to its unset (`undefined`) state.
   * Used by FormRenderer's non-list 'object' case so a non-list object with
   * a required child can't get stuck present-but-invalid with no way back
   * to "not filled in" (see FormRenderer.tsx's `case 'object'`). Omitted
   * for object-list items, which are removed via the list's own per-item
   * Remove button instead.
   */
  onRemove?: () => void
}

export const ObjectField: React.FC<ObjectFieldProps> = ({
  label,
  fields,
  value,
  onChange,
  renderField,
  path,
  dataCanopyField,
  onRemove,
}) => {
  const current = value ?? {}

  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      bg="gray.0"
      data-canopy-field={dataCanopyField ?? formatCanopyPath(path)}
      shadow="xs"
    >
      <Stack gap="sm">
        {(label || onRemove) && (
          <Group justify="space-between">
            {label && (
              <Text size="xs" fw={700} c="neutral.8">
                {label}
              </Text>
            )}
            {onRemove && (
              <Button size="xs" variant="subtle" color="red" onClick={onRemove}>
                Clear
              </Button>
            )}
          </Group>
        )}
        <Stack gap="sm">
          {fields.map((field) => {
            const fieldPath = [...path, field.name]
            return (
              <div key={formatCanopyPath(fieldPath)}>
                {renderField(
                  field,
                  current[field.name],
                  (next) => onChange({ ...current, [field.name]: next }),
                  fieldPath,
                )}
              </div>
            )
          })}
        </Stack>
      </Stack>
    </Paper>
  )
}

export default ObjectField
