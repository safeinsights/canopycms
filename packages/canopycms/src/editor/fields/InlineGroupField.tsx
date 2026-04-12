import React from 'react'

import { Paper, Stack, Text } from '@mantine/core'

import type { FieldConfig, InlineGroupFieldConfig } from '../../config'
import { formatCanopyPath } from '../canopy-path'
import type { RenderField } from './ObjectField'

export interface InlineGroupFieldProps {
  label?: string
  description?: string
  fields: FieldConfig[]
  /** The parent form value — inline groups read/write at this level, not under a nested key. */
  value: Record<string, unknown>
  onChange: (value: Record<string, unknown>) => void
  renderField: RenderField
  /** Path of the parent scope (no group name segment — groups are transparent to paths). */
  path: Array<string | number>
}

export const InlineGroupField: React.FC<InlineGroupFieldProps> = ({
  label,
  description,
  fields,
  value,
  onChange,
  renderField,
  path,
}) => {
  return (
    <Paper withBorder radius="md" p="md" bg="gray.0" shadow="xs">
      <Stack gap="sm">
        {(label || description) && (
          <Stack gap={2}>
            {label && (
              <Text size="xs" fw={700} c="dimmed">
                {label}
              </Text>
            )}
            {description && (
              <Text size="xs" c="dimmed">
                {description}
              </Text>
            )}
          </Stack>
        )}
        <Stack gap="sm">
          {fields.map((field) => {
            // Nested inline groups are also transparent — pass the same parent value/onChange
            if (field.type === 'group') {
              const childGroup = field as InlineGroupFieldConfig
              return (
                <InlineGroupField
                  key={`group-${childGroup.name}`}
                  label={childGroup.label}
                  description={childGroup.description}
                  fields={childGroup.fields}
                  value={value}
                  onChange={onChange}
                  renderField={renderField}
                  path={path}
                />
              )
            }

            const fieldPath = [...path, field.name]
            return (
              <div key={formatCanopyPath(fieldPath)}>
                {renderField(
                  field,
                  value[field.name],
                  (next) => onChange({ ...value, [field.name]: next }),
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

export default InlineGroupField
