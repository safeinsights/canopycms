import React, { useId } from 'react'

import { MultiSelect, Select, Stack, Text } from '@mantine/core'

import { listFullReason } from '../copy'
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
  /** With `multiple`, the most values it holds; at it, the hint says why it takes no more. */
  maxItems?: number
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
  maxItems,
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
          // Mantine names the options listbox from its own label prop, absent here.
          aria-label={label}
          description={description}
          data={options}
          value={normalizedValue as string[]}
          readOnly={readOnly}
          rightSection={readOnly ? <span /> : undefined}
          onChange={(next) => {
            if (!readOnly) onChange(next)
          }}
          searchable
          maxValues={maxItems}
          placeholder={readOnly ? undefined : placeholder}
          size="sm"
        />
      ) : (
        <Select
          id={inputId}
          aria-label={label}
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
          {maxItems !== undefined && normalizedValue.length >= maxItems
            ? listFullReason(maxItems)
            : 'Searchable multi-select; start typing to filter.'}
        </Text>
      )}
    </Stack>
  )
}
