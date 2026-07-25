import React, { useId } from 'react'

import { TagsInput } from '@mantine/core'

export interface StringListFieldProps {
  id?: string
  label?: string
  value: string[]
  onChange: (value: string[]) => void
  dataCanopyField?: string
}

/**
 * Editor for `type: 'string', list: true` fields.
 *
 * Uses Mantine's TagsInput: type + Enter adds an item, each item renders as a
 * removable pill, and Backspace on an empty input removes the last item.
 * (Before this component existed, string-list fields fell through to the
 * single-value TextField, which coerced the array to a comma-joined string —
 * effectively unsupported.)
 */
export const StringListField: React.FC<StringListFieldProps> = ({
  id,
  label,
  value,
  onChange,
  dataCanopyField,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <TagsInput
      id={inputId}
      label={label}
      value={value}
      size="sm"
      onChange={onChange}
      data-canopy-field={dataCanopyField}
    />
  )
}

export default StringListField
