import React, { useId, useState } from 'react'

import { TagsInput } from '@mantine/core'

export interface NumberListFieldProps {
  id?: string
  label?: string
  value: number[]
  onChange: (value: number[]) => void
  dataCanopyField?: string
}

/**
 * A tag is a number only if it is non-blank AND parses finitely.
 *
 * The blank check is not redundant: `Number('')` and `Number('  ')` are both
 * `0`, so a blank tag would otherwise be stored as a spurious `0` rather
 * than rejected.
 */
const parseTag = (tag: string): number | undefined => {
  const trimmed = tag.trim()
  if (trimmed === '') return undefined
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : undefined
}

/**
 * Editor for `type: 'number', list: true` fields.
 *
 * Mirrors `StringListField`'s `TagsInput` approach (type + Enter adds an
 * item, Backspace on empty removes the last) since Mantine has no numeric
 * equivalent. A tag that doesn't parse to a finite number is dropped rather
 * than stored as `NaN`.
 *
 * A dropped tag is reported, not silently swallowed — otherwise it vanished
 * on Enter indistinguishably from being accepted, with nothing to tell a
 * typo from a broken field — so rejected text is named in the error slot.
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
  const [rejected, setRejected] = useState<string[]>([])

  return (
    <TagsInput
      id={inputId}
      label={label}
      value={value.map(String)}
      size="sm"
      error={
        rejected.length > 0
          ? `Not ${rejected.length === 1 ? 'a number' : 'numbers'}: ${rejected.join(', ')}`
          : undefined
      }
      onChange={(next) => {
        const parsed: number[] = []
        const dropped: string[] = []
        for (const tag of next) {
          const num = parseTag(tag)
          if (num === undefined) dropped.push(tag)
          else parsed.push(num)
        }
        setRejected(dropped)
        onChange(parsed)
      }}
      splitChars={[]}
      allowDuplicates
      data-canopy-field={dataCanopyField}
    />
  )
}
