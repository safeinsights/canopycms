import React, { useEffect, useId, useState } from 'react'

import { MultiSelect, Select, Stack, Text, Loader } from '@mantine/core'

import { createApiClient } from '../../api/client'

export interface ReferenceOption {
  value: string
  label: string
}

export interface ReferenceFieldProps {
  id?: string
  label?: string
  options?: ReferenceOption[] // Now optional - will be loaded from API if not provided
  collections?: string[] // Collections to load options from
  displayField?: string // Field to use for display label
  branch?: string // Current branch
  value: string | string[]
  onChange: (value: string | string[]) => void
  multiple?: boolean
  dataCanopyField?: string
}

export const ReferenceField: React.FC<ReferenceFieldProps> = ({
  id,
  label,
  options: staticOptions,
  collections,
  displayField = 'title',
  branch = 'main',
  value,
  onChange,
  multiple,
  dataCanopyField,
}) => {
  const [options, setOptions] = useState<ReferenceOption[]>(staticOptions || [])
  const [loading, setLoading] = useState(false)

  // Extract ID from value - handle both string IDs and resolved objects
  const extractId = (val: unknown): string => {
    if (typeof val === 'string') return val
    if (val && typeof val === 'object' && 'id' in val && typeof val.id === 'string') return val.id
    return ''
  }

  const normalizedValue = multiple
    ? Array.isArray(value)
      ? value.map(extractId)
      : []
    : extractId(value)
  const inputId = id ?? useId()

  // Load options from API if collections are provided and no static options
  useEffect(() => {
    if (!staticOptions && collections && collections.length > 0) {
      setLoading(true)
      const apiClient = createApiClient()

      apiClient.content
        .getReferenceOptions({
          branch,
          collections: collections.join(','),
          displayField,
        })
        .then((response) => {
          if (response.ok && response.data?.options) {
            const mappedOptions = response.data.options.map(
              (opt: { id: string; label: string }) => ({
                value: opt.id,
                label: opt.label,
              }),
            )
            setOptions(mappedOptions)
          }
        })
        .catch((err) => {
          console.error('Failed to load reference options:', err)
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [staticOptions, collections, displayField, branch])

  if (loading) {
    return (
      <Stack gap={4} data-canopy-field={dataCanopyField}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Loader size="sm" />
      </Stack>
    )
  }

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
    </Stack>
  )
}

export default ReferenceField
