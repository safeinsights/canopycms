import React, { useId } from 'react'

import { Stack, Switch } from '@mantine/core'

import { FieldDescription, fieldDescriptionId } from './FieldDescription'

export interface ToggleFieldProps {
  id?: string
  label?: string
  description?: string
  value: boolean
  onChange: (value: boolean) => void
  dataCanopyField?: string
  testId?: string
}

export const ToggleField: React.FC<ToggleFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
  testId,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  // A Switch's `description` sits inside its <label> and so joins the accessible name;
  // rendering it as a sibling keeps the name to the label alone.
  return (
    <Stack gap={4}>
      <Switch
        id={inputId}
        label={label}
        aria-describedby={description ? fieldDescriptionId(inputId) : undefined}
        checked={value}
        onChange={(e) => onChange(e.currentTarget.checked)}
        size="md"
        data-canopy-field={dataCanopyField}
        wrapperProps={testId ? { 'data-testid': testId } : undefined}
      />
      <FieldDescription baseId={inputId} description={description} />
    </Stack>
  )
}
