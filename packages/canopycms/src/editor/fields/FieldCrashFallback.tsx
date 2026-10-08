'use client'

import React from 'react'

import { Alert, Code, Group, Paper, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'

import { CopyErrorDetailsButton, type CaughtEditorError } from '../components/EditorErrorBoundary'
import { getErrorMessage, sanitizeErrorMessage } from '../../utils/error'
import { MarkdownSourceEditor } from './MarkdownField'

const displayValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '(empty)'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export interface FieldCrashFallbackProps {
  label: string
  fieldType: string
  value: unknown
  /** Used only by markdown and mdx fields, whose raw text the author edits directly. */
  onChange: (value: unknown) => void
  caught: CaughtEditorError
  dataCanopyField?: string
}

/**
 * What a field that threw while rendering shows: its value read-only, so Save writes back
 * exactly what is on screen, or, for a markdown or mdx field holding text, that text, still
 * editable.
 */
export const FieldCrashFallback: React.FC<FieldCrashFallbackProps> = ({
  label,
  fieldType,
  value,
  onChange,
  caught,
  dataCanopyField,
}) => {
  // Only text is editable as source; any other value would show as an empty box to type over.
  const editableSource =
    (fieldType === 'markdown' || fieldType === 'mdx') &&
    (typeof value === 'string' || value === undefined || value === null)
  return (
    <Paper
      withBorder
      radius="sm"
      p="sm"
      data-testid="field-crash-fallback"
      data-canopy-field={dataCanopyField}
    >
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {label}
        </Text>
        {editableSource ? (
          <MarkdownSourceEditor
            label={label}
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
            failure={sanitizeErrorMessage(getErrorMessage(caught.error))}
          />
        ) : (
          <>
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">
                This field couldn&apos;t be shown because of an error. Its value is below and
                won&apos;t be changed. You can keep editing the other fields and save.
              </Text>
            </Alert>
            <Code block data-testid="field-crash-value" style={{ whiteSpace: 'pre-wrap' }}>
              {displayValue(value)}
            </Code>
          </>
        )}
        <Group>
          <CopyErrorDetailsButton caught={caught} />
        </Group>
      </Stack>
    </Paper>
  )
}
