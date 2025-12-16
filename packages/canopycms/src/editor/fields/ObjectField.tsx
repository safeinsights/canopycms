import React from 'react'

import { Paper, Stack, Text } from '@mantine/core'

import type { FieldConfig } from '../../config'
import { formatCanopyPath } from '../canopy-path'

export type RenderField = (
  field: FieldConfig,
  value: unknown,
  onChange: (v: unknown) => void,
  path: Array<string | number>
) => React.ReactNode

export interface ObjectFieldProps {
  label?: string
  fields: FieldConfig[]
  value: Record<string, unknown> | undefined
  onChange: (value: Record<string, unknown>) => void
  renderField: RenderField
  path: Array<string | number>
  dataCanopyField?: string
}

export const ObjectField: React.FC<ObjectFieldProps> = ({
  label,
  fields,
  value,
  onChange,
  renderField,
  path,
  dataCanopyField,
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
        {label && (
          <Text size="xs" fw={700} c="neutral.8">
            {label}
          </Text>
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
                  fieldPath
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
