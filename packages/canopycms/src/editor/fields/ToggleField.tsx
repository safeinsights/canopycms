import React, { useId } from 'react'

import { Switch } from '@mantine/core'

export interface ToggleFieldProps {
  id?: string
  label?: string
  value: boolean
  onChange: (value: boolean) => void
  dataCanopyField?: string
}

export const ToggleField: React.FC<ToggleFieldProps> = ({
  id,
  label,
  value,
  onChange,
  dataCanopyField,
}) => {
  const inputId = id ?? useId()
  return (
    <Switch
      id={inputId}
      label={label}
      checked={value}
      onChange={(e) => onChange(e.currentTarget.checked)}
      size="md"
      data-canopy-field={dataCanopyField}
    />
  )
}

export default ToggleField
