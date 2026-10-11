import React, { useId } from 'react'

import { TextInput } from '@mantine/core'

export interface TextFieldProps {
  id?: string
  label?: string
  description?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
}

export const TextField: React.FC<TextFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
  readOnly = false,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <TextInput
      id={inputId}
      label={label}
      description={description}
      value={value}
      size="sm"
      readOnly={readOnly}
      onChange={(e) => {
        if (!readOnly) onChange(e.currentTarget.value)
      }}
      data-canopy-field={dataCanopyField}
    />
  )
}
