import React, { useId } from 'react'

import { MultiSelect, Select, Stack, Text } from '@mantine/core'

export interface ReferenceOption {
  value: string
  label: string
}

export interface ReferenceFieldProps {
  id?: string
  label?: string
  options: ReferenceOption[]
  value: string | string[]
  onChange: (value: string | string[]) => void
  multiple?: boolean
  dataCanopyField?: string
}

export const ReferenceField: React.FC<ReferenceFieldProps> = ({
  id,
  label,
  options,
  value,
  onChange,
  multiple,
  dataCanopyField,
}) => {
  const normalizedValue = multiple ? (Array.isArray(value) ? value : []) : typeof value === 'string' ? value : ''
  const inputId = id ?? useId()

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
          placeholder="Select reference…"
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
          placeholder="Select reference…"
          size="sm"
        />
      )}
      {multiple && (
        <Text size="xs" c="dimmed">
          Hold Cmd/Ctrl to select multiple. (Upgrade: searchable, async reference lookup)
        </Text>
      )}
    </Stack>
  )
}

export default ReferenceField
