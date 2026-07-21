'use client'

import React, { useEffect, useId, useState } from 'react'

import { Alert, Button, MultiSelect, Select, Stack, Text, Loader } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { createApiClient } from '../../api/client'
import { getErrorMessage } from '../../utils/error'

export interface ReferenceOption {
  value: string
  label: string
}

export interface ReferenceFieldProps {
  id?: string
  label?: string
  options?: ReferenceOption[] // Now optional - will be loaded from API if not provided
  collections?: string[] // Collections to load options from (includes subcollections)
  entryTypes?: string[] // Entry types to filter by (e.g., ['partner'])
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
  entryTypes,
  displayField = 'title',
  branch = 'main',
  value,
  onChange,
  multiple,
  dataCanopyField,
}) => {
  const hasCollections = !!collections && collections.length > 0
  const hasEntryTypes = !!entryTypes && entryTypes.length > 0
  const needsFetch = !staticOptions && (hasCollections || hasEntryTypes)
  const [options, setOptions] = useState<ReferenceOption[]>(staticOptions || [])
  const [loading, setLoading] = useState(needsFetch)
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

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
  const generatedId = useId()
  const inputId = id ?? generatedId

  // Track deps to detect changes and reset loading during render
  const [prevFetchKey, setPrevFetchKey] = useState('')
  const fetchKey = needsFetch
    ? `${collections?.join(',') ?? ''}:${entryTypes?.join(',') ?? ''}:${displayField}:${branch}`
    : ''
  if (fetchKey !== prevFetchKey) {
    setPrevFetchKey(fetchKey)
    if (needsFetch) {
      setLoading(true)
      setError(null)
    }
  }

  // Load options from API if collections or entryTypes are provided and no static options
  useEffect(() => {
    if (needsFetch) {
      const apiClient = createApiClient()

      const params: Record<string, string> = { branch, displayField }
      if (collections && collections.length > 0) params.collections = collections.join(',')
      if (entryTypes && entryTypes.length > 0) params.entryTypes = entryTypes.join(',')

      apiClient.content
        .getReferenceOptions(params)
        .then((response) => {
          if (response.ok && response.data?.options) {
            const mappedOptions = response.data.options.map(
              (opt: { id: string; label: string }) => ({
                value: opt.id,
                label: opt.label,
              }),
            )
            setOptions(mappedOptions)
          } else {
            setError(response.error || 'Failed to load reference options')
          }
        })
        .catch((err) => {
          console.error('Failed to load reference options:', err)
          setError(getErrorMessage(err))
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [needsFetch, collections, entryTypes, displayField, branch, retryCount])

  const handleRetry = () => {
    setLoading(true)
    setError(null)
    setRetryCount((count) => count + 1)
  }

  if (loading) {
    return (
      <Stack
        gap={4}
        data-canopy-field={dataCanopyField}
        data-testid={`reference-field-${dataCanopyField}`}
      >
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Loader size="sm" data-testid={`reference-loading-${dataCanopyField}`} />
      </Stack>
    )
  }

  if (error) {
    return (
      <Stack
        gap={4}
        data-canopy-field={dataCanopyField}
        data-testid={`reference-field-${dataCanopyField}`}
      >
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          title="Error"
          data-testid={`reference-error-${dataCanopyField}`}
        >
          <Stack gap={4}>
            <Text size="sm">{error}</Text>
            <Button
              size="xs"
              variant="light"
              onClick={handleRetry}
              data-testid={`reference-retry-${dataCanopyField}`}
            >
              Retry
            </Button>
          </Stack>
        </Alert>
      </Stack>
    )
  }

  return (
    <Stack
      gap={4}
      data-canopy-field={dataCanopyField}
      data-testid={`reference-field-${dataCanopyField}`}
    >
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
