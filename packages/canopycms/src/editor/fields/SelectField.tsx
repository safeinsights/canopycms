import React, { useId } from 'react'

import { MultiSelect, Select, Stack, Text } from '@mantine/core'

import { useFieldCommentControl } from '../comments/field-comment-context'
import { FieldLabel } from './FieldLabel'

interface SelectOption {
  label: string
  value: string
}

export interface SelectFieldProps {
  id?: string
  label?: string
  description?: string
  options: SelectOption[]
  value: string | string[]
  onChange: (value: string | string[]) => void
  multiple?: boolean
  placeholder?: string
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
}

export const SelectField: React.FC<SelectFieldProps> = ({
  id,
  label,
  description,
  options,
  value,
  onChange,
  multiple,
  placeholder = 'Select…',
  dataCanopyField,
  readOnly = false,
}) => {
  const normalizedValue = multiple
    ? Array.isArray(value)
      ? value
      : []
    : typeof value === 'string'
      ? value
      : ''
  const generatedId = useId()
  const inputId = id ?? generatedId
  const commentControl = useFieldCommentControl(dataCanopyField)

  return (
    <Stack gap={4} data-canopy-field={dataCanopyField}>
      <FieldLabel label={label} htmlFor={inputId} commentControl={commentControl} />
      {multiple ? (
        <MultiSelect
          id={inputId}
          description={description}
          data={options}
          value={normalizedValue as string[]}
          readOnly={readOnly}
          rightSection={readOnly ? <span /> : undefined}
          onChange={(next) => {
            if (!readOnly) onChange(next)
          }}
          searchable
          placeholder={readOnly ? undefined : placeholder}
          size="sm"
        />
      ) : (
        <Select
          id={inputId}
          description={description}
          data={options}
          value={normalizedValue as string}
          readOnly={readOnly}
          rightSection={readOnly ? <span /> : undefined}
          onChange={(next) => {
            if (!readOnly) onChange(next ?? '')
          }}
          searchable
          clearable
          placeholder={readOnly ? undefined : placeholder}
          size="sm"
        />
      )}
      {multiple && !readOnly && (
        <Text size="xs" c="dimmed">
          Searchable multi-select; start typing to filter.
        </Text>
      )}
    </Stack>
  )
}
