import React, { useId } from 'react'

import { Textarea } from '@mantine/core'

export interface CodeFieldProps {
  id?: string
  label?: string
  description?: string
  value: string
  onChange: (value: string) => void
  language?: string
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
}

// Placeholder for Monaco integration; host app can provide custom renderer for production.
export const CodeField: React.FC<CodeFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  language,
  dataCanopyField,
  readOnly = false,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <Textarea
      id={inputId}
      label={label}
      description={description}
      value={value}
      readOnly={readOnly}
      onChange={(e) => {
        if (!readOnly) onChange(e.currentTarget.value)
      }}
      placeholder={language ? `Code (${language})` : 'Code'}
      autosize
      minRows={6}
      size="sm"
      data-canopy-field={dataCanopyField}
      styles={{ input: { fontFamily: 'Menlo, Consolas, monospace' } }}
    />
  )
}
