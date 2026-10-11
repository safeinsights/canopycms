import React, { useId } from 'react'

import { Group, Stack, Switch, Text } from '@mantine/core'

import { FieldDescription, fieldDescriptionId } from './FieldDescription'

export interface ToggleFieldProps {
  id?: string
  label?: string
  description?: string
  value: boolean
  onChange: (value: boolean) => void
  dataCanopyField?: string
  testId?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
}

export const ToggleField: React.FC<ToggleFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
  testId,
  readOnly = false,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  // A Switch's `description` sits inside its <label> and so joins the accessible name;
  // rendering it as a sibling keeps the name to the label alone.
  return (
    <Stack gap={4}>
      <Group gap="sm" wrap="nowrap">
        <Switch
          id={inputId}
          label={label}
          aria-describedby={description ? fieldDescriptionId(inputId) : undefined}
          checked={value}
          disabled={readOnly}
          onChange={(e) => {
            if (!readOnly) onChange(e.currentTarget.checked)
          }}
          size="md"
          data-canopy-field={dataCanopyField}
          wrapperProps={testId ? { 'data-testid': testId } : undefined}
        />
        {/* A disabled switch's position is too faint to read, so read-only states it in words. */}
        {readOnly && (
          <Text size="sm" c="gray.7" data-testid={testId ? `${testId}-value` : undefined}>
            {value ? 'On' : 'Off'}
          </Text>
        )}
      </Group>
      <FieldDescription baseId={inputId} description={description} />
    </Stack>
  )
}
