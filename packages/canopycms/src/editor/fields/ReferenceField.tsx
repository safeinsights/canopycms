'use client'

import React, { useId } from 'react'

import { Alert, Button, Group, Select, Stack, Text, Loader } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { useFieldCommentControl } from '../comments/field-comment-context'
import { FieldDescription, groupDescriptionProps } from './FieldDescription'
import { FieldLabel } from './FieldLabel'
import {
  HiddenFromSearchBadge,
  HiddenPicksNote,
  referenceOptionRenderer,
} from './reference-noindex'
import type { ReferenceOptionSort } from '../../config'
import {
  extractId,
  unlistedReferenceLabel,
  useReferenceOptions,
  type ReferenceOption,
} from './use-reference-options'

/** @internal Exported for tests. */
export type { ReferenceOption }

export interface ReferenceFieldProps {
  id?: string
  label?: string
  description?: string
  options?: ReferenceOption[] // Loaded from the API when not provided
  collections?: string[] // Collections to load options from (includes subcollections)
  entryTypes?: string[] // Entry types to filter by (e.g., ['partner'])
  displayField?: string // Field to use for display label
  branch?: string // Current branch
  optionSort?: ReferenceOptionSort
  value: unknown
  onChange: (value: string) => void
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
}

export const ReferenceField: React.FC<ReferenceFieldProps> = ({
  id,
  label,
  description,
  options: staticOptions,
  collections,
  entryTypes,
  displayField = 'title',
  branch = 'main',
  optionSort,
  value,
  onChange,
  dataCanopyField,
  readOnly = false,
}) => {
  const { options, loading, error, retry } = useReferenceOptions({
    staticOptions,
    collections,
    entryTypes,
    displayField,
    branch,
    optionSort,
  })
  const normalizedValue = extractId(value)

  // Otherwise Select shows a set value as empty, inviting an editor to repoint it.
  const listed = new Set(options.map((option) => option.value))
  const data =
    normalizedValue && !listed.has(normalizedValue)
      ? [
          ...options,
          { value: normalizedValue, label: unlistedReferenceLabel(value, normalizedValue) },
        ]
      : options
  const generatedId = useId()
  const inputId = id ?? generatedId
  const commentControl = useFieldCommentControl(dataCanopyField)

  const settled = !loading && !error
  const pickedOption = options.find((option) => option.value === normalizedValue)
  const hidden = settled && pickedOption?.noindex ? pickedOption : undefined

  // One label row for every state, so the comment popover in it survives loading and Retry.
  return (
    <Stack
      gap={4}
      data-canopy-field={dataCanopyField}
      data-testid={`reference-field-${dataCanopyField}`}
      {...(settled ? {} : groupDescriptionProps(inputId, description))}
    >
      <FieldLabel
        label={label}
        htmlFor={settled ? inputId : undefined}
        commentControl={commentControl}
      />
      {loading ? (
        <>
          <FieldDescription baseId={inputId} description={description} />
          <Loader size="sm" data-testid={`reference-loading-${dataCanopyField}`} />
        </>
      ) : error ? (
        <>
          <FieldDescription baseId={inputId} description={description} />
          <Alert
            icon={<IconAlertCircle size={16} />}
            color="red"
            title="Error"
            data-testid={`reference-error-${dataCanopyField}`}
          >
            <Stack gap={4}>
              <Text size="sm">{error}</Text>
              <Button
                variant="light"
                onClick={retry}
                data-testid={`reference-retry-${dataCanopyField}`}
              >
                Retry
              </Button>
            </Stack>
          </Alert>
        </>
      ) : (
        <>
          <Select
            id={inputId}
            aria-label={label}
            description={description}
            data={data}
            renderOption={referenceOptionRenderer(options)}
            inputContainer={(input) =>
              hidden ? (
                <Group gap="xs" wrap="nowrap">
                  <div style={{ flex: 1, minWidth: 0 }}>{input}</div>
                  <HiddenFromSearchBadge />
                </Group>
              ) : (
                input
              )
            }
            value={normalizedValue}
            readOnly={readOnly}
            rightSection={readOnly ? <span /> : undefined}
            onChange={(next) => {
              if (!readOnly) onChange(next ?? '')
            }}
            searchable
            clearable
            placeholder={readOnly ? undefined : 'Select reference…'}
            size="sm"
          />
          {hidden?.noindex && (
            <HiddenPicksNote
              picks={[{ label: hidden.label, fieldLabel: hidden.noindex.fieldLabel }]}
            />
          )}
        </>
      )}
    </Stack>
  )
}
