import React, { useId } from 'react'

import { Button, Paper, Stack } from '@mantine/core'

import type { FieldConfig } from '../../config'
import { isPlainRecord } from '../../validation/field-traversal'
import { formatCanopyPath } from '../canopy-path'
import { useFieldCommentControl } from '../comments/field-comment-context'
import { EDITOR_ACTIONS } from '../copy'
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
  /** Set, shows a gray "Clear" resetting the field to `undefined`; omitted for list items. */
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
  const commentControl = useFieldCommentControl(dataCanopyField ?? formatCanopyPath(path))

  return (
    <Paper
      withBorder
      p="md"
      bg="var(--canopy-surface-subtle)"
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
          commentControl={commentControl}
          actions={
            onRemove && (
              <Button variant="subtle" color="gray" onClick={onRemove}>
                {EDITOR_ACTIONS.clear}
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
