import React, { useId } from 'react'

import { TagsInput } from '@mantine/core'

export interface NumberListFieldProps {
  id?: string
  label?: string
  value: number[]
  onChange: (value: number[]) => void
  dataCanopyField?: string
}

/**
 * Editor for `type: 'number', list: true` fields.
 *
 * Mirrors `StringListField`'s approach (Mantine's `TagsInput`: type + Enter
 * adds an item, Backspace on an empty input removes the last one) since
 * there is no numeric equivalent in Mantine. Tags are parsed to numbers on
 * change; a tag that doesn't parse to a finite number is dropped rather
 * than silently stored as `NaN` or a string.
 */
export const NumberListField: React.FC<NumberListFieldProps> = ({
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
      value={value.map(String)}
      size="sm"
      onChange={(next) => {
        const parsed = next.map((tag) => Number(tag.trim())).filter((num) => Number.isFinite(num))
        onChange(parsed)
      }}
      splitChars={[]}
      allowDuplicates
      data-canopy-field={dataCanopyField}
    />
  )
}

export default NumberListField
