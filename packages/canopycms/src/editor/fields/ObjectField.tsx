import React, { useId } from 'react'

import { Button, Paper, Stack } from '@mantine/core'

import type { FieldConfig } from '../../config'
import { isPlainRecord } from '../../validation/field-traversal'
import { formatCanopyPath } from '../canopy-path'
import { groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'

export type RenderField = (
  field: FieldConfig,
  value: unknown,
  onChange: (v: unknown) => void,
  path: Array<string | number>,
) => React.ReactNode

export interface ObjectFieldProps {
  label?: string
  required?: boolean
  description?: string
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
  required,
  description,
  fields,
  value,
  onChange,
  renderField,
  path,
  dataCanopyField,
  onRemove,
}) => {
  const current = isPlainRecord(value) ? value : {}
  const descriptionBaseId = useId()

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
          label={label}
          required={required}
          description={description}
          descriptionBaseId={descriptionBaseId}
          actions={
            onRemove && (
              <Button variant="subtle" color="red" onClick={onRemove}>
                Clear
              </Button>
            )
          }
        />
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
