import React, { useId } from 'react'

import { Switch } from '@mantine/core'

import { fieldDescriptionId } from './FieldDescription'

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
  return (
    <Switch
      id={inputId}
      label={label}
      // Switch renders `description` without an id or aria-describedby, so both are supplied here.
      description={
        description ? <span id={fieldDescriptionId(inputId)}>{description}</span> : undefined
      }
      aria-describedby={description ? fieldDescriptionId(inputId) : undefined}
      checked={value}
      onChange={(e) => onChange(e.currentTarget.checked)}
      size="md"
      data-canopy-field={dataCanopyField}
      wrapperProps={testId ? { 'data-testid': testId } : undefined}
    />
  )
}
