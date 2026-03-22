import React, { useId } from 'react'

import { MultiSelect, Select, Stack, Text } from '@mantine/core'

export interface SelectOption {
  label: string
  value: string
}

export interface SelectFieldProps {
  id?: string
  label?: string
  options: SelectOption[]
  value: string | string[]
  onChange: (value: string | string[]) => void
  multiple?: boolean
  placeholder?: string
  dataCanopyField?: string
}

export const SelectField: React.FC<SelectFieldProps> = ({
  id,
  label,
  options,
  value,
  onChange,
  multiple,
  placeholder = 'Select…',
  dataCanopyField,
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

  return (
    <Stack gap={4} data-canopy-field={dataCanopyField}>
      {multiple ? (
        <MultiSelect
          id={inputId}
          label={label}
          data={options}
          value={normalizedValue as string[]}
          onChange={(next) => onChange(next)}
          searchable
          placeholder={placeholder}
          size="sm"
        />
      ) : (
        <Select
          id={inputId}
          label={label}
          data={options}
          value={normalizedValue as string}
          onChange={(next) => onChange(next ?? '')}
          searchable
          clearable
          placeholder={placeholder}
          size="sm"
        />
      )}
      {multiple && (
        <Text size="xs" c="dimmed">
          Searchable multi-select; start typing to filter.
        </Text>
      )}
    </Stack>
  )
}

export default SelectField
