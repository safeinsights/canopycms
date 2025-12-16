import React, { useId } from 'react'

import { TextInput } from '@mantine/core'

export interface TextFieldProps {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
}

export const TextField: React.FC<TextFieldProps> = ({ id, label, value, onChange, dataCanopyField }) => {
  const inputId = id ?? useId()

  return (
    <TextInput
      id={inputId}
      label={label}
      value={value}
      size="sm"
      onChange={(e) => onChange(e.currentTarget.value)}
      data-canopy-field={dataCanopyField}
    />
  )
}

export default TextField
