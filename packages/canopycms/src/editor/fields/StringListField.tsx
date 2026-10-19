import React, { useId } from 'react'

import { TagsInput } from '@mantine/core'

import { listFullReason } from '../copy'
import { LabelledInput } from './FieldLabel'

export interface StringListFieldProps {
  id?: string
  label?: string
  description?: string
  value: string[]
  onChange: (value: string[]) => void
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
  /** The most items the list holds; at it, Enter adds nothing and the hint says why. */
  maxItems?: number
}

/** The field's description, ended as a sentence, then `hint`. */
export const withHint = (description: string | undefined, hint: string): string => {
  const own = description?.trim()
  if (!own) return hint
  return `${/[.!?]$/.test(own) ? own : `${own}.`} ${hint}`
}

/**
 * Editor for `type: 'string', list: true` fields.
 *
 * Uses Mantine's TagsInput: type + Enter adds an item, each item renders as a
 * removable pill, and Backspace on an empty input removes the last item. An editable list says
 * that Enter adds, after the field's own description, or at `maxItems` why it adds no more.
 */
export const StringListField: React.FC<StringListFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
  readOnly = false,
  maxItems,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <LabelledInput label={label} inputId={inputId} canopyPath={dataCanopyField}>
      <TagsInput
        id={inputId}
        // TagsInput gives no sign that Enter adds a typed item, nor why it stops at `maxTags`.
        description={
          readOnly
            ? description
            : withHint(
                description,
                maxItems !== undefined && value.length >= maxItems
                  ? listFullReason(maxItems)
                  : 'Press Enter to add.',
              )
        }
        maxTags={maxItems}
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
    </LabelledInput>
  )
}
