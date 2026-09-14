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
   * When set, shows a "Clear" affordance that resets this field to unset
   * (`undefined`) — used by `FormRenderer.tsx`'s non-list `case 'object'` so
   * a required child can't strand the field present-but-invalid with no way
   * back to "not filled in". Omitted for object-list items, which remove via
   * the list's own per-item button.
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
