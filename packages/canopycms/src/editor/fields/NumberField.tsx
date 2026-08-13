import React, { useId } from 'react'

import { NumberInput } from '@mantine/core'

export interface NumberFieldProps {
  id?: string
  label?: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  dataCanopyField?: string
}

/**
 * Editor for `type: 'number'` fields.
 *
 * `undefined` means "not filled in" and is distinct from `0`: an empty
 * input must not silently become `0` (that would make a required numeric
 * field with value `0` look correct while an actually-empty field also
 * looks fine), and `0` must not be mistaken for "absent". Mantine's
 * `NumberInput` reports an empty input as `''`; we translate that to
 * `undefined` so `validation/entry-validator.ts`'s required check (which
 * treats only `undefined`/`null` as empty for numbers) agrees with what the
 * form displays.
 */
export const NumberField: React.FC<NumberFieldProps> = ({
  id,
  label,
  value,
  onChange,
  dataCanopyField,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <NumberInput
      id={inputId}
      label={label}
      value={value ?? ''}
      size="sm"
      onChange={(next) => {
        if (next === '') {
          onChange(undefined)
          return
        }
        const num = typeof next === 'number' ? next : Number(next)
        onChange(Number.isFinite(num) ? num : undefined)
      }}
      data-canopy-field={dataCanopyField}
    />
  )
}

export default NumberField
