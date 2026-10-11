import React, { useId } from 'react'

import { TagsInput } from '@mantine/core'

export interface StringListFieldProps {
  id?: string
  label?: string
  description?: string
  value: string[]
  onChange: (value: string[]) => void
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
}

/**
 * Editor for `type: 'string', list: true` fields.
 *
 * Uses Mantine's TagsInput: type + Enter adds an item, each item renders as a
 * removable pill, and Backspace on an empty input removes the last item.
 */
export const StringListField: React.FC<StringListFieldProps> = ({
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
    <TagsInput
      id={inputId}
      label={label}
      description={description}
      value={value}
      size="sm"
      readOnly={readOnly}
      onChange={(next) => {
        if (!readOnly) onChange(next)
      }}
      // Faithful generic-list semantics, not tag ergonomics: no comma-splitting
      // ("New York, NY" stays one item) and duplicates are legitimate list
      // data — TagsInput's defaults would break both, so existing file data
      // couldn't round-trip.
      splitChars={[]}
      allowDuplicates
      data-canopy-field={dataCanopyField}
    />
  )
}
