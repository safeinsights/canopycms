import React, { useId } from 'react'

import { Textarea } from '@mantine/core'

export interface CodeFieldProps {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  language?: string
  dataCanopyField?: string
}

// Placeholder for Monaco integration; host app can provide custom renderer for production.
export const CodeField: React.FC<CodeFieldProps> = ({
  id,
  label,
  value,
  onChange,
  language,
  dataCanopyField,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <Textarea
      id={inputId}
      label={label}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder={language ? `Code (${language})` : 'Code'}
      autosize
      minRows={6}
      size="sm"
      data-canopy-field={dataCanopyField}
      styles={{ input: { fontFamily: 'Menlo, Consolas, monospace' } }}
    />
  )
}

export default CodeField
