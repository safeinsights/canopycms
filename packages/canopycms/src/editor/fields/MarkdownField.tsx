import React, { useId } from 'react'

import { Textarea } from '@mantine/core'

export interface MarkdownFieldProps {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
}

export const MarkdownField: React.FC<MarkdownFieldProps> = ({
  id,
  label,
  value,
  onChange,
  dataCanopyField,
}) => {
  const inputId = id ?? useId()

  return (
    <Textarea
      id={inputId}
      label={label}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder="Write markdown..."
      autosize
      minRows={6}
      size="sm"
      data-canopy-field={dataCanopyField}
    />
  )
}

export default MarkdownField
