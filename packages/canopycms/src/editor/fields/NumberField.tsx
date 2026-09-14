import React, { useId, useState } from 'react'

import { NumberInput } from '@mantine/core'

export interface NumberFieldProps {
  id?: string
  label?: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  dataCanopyField?: string
}

/**
 * The numeric meaning of whatever Mantine last reported, or `undefined` for
 * "not filled in" / not yet a number (`''`, a lone `'-'`).
 */
const toNumericValue = (raw: string | number): number | undefined => {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (raw.trim() === '') return undefined
  const num = Number(raw)
  return Number.isFinite(num) ? num : undefined
}

/**
 * Editor for `type: 'number'` fields.
 *
 * `undefined` (not `0`) means "not filled in": Mantine's `NumberInput` reports
 * an empty input as `''`, which this field translates to `undefined` so
 * `validation/entry-validator.ts`'s required check agrees with the form.
 *
 * The in-progress TEXT is mirrored back, not the parsed number. Mantine
 * reports the entry as a string exactly when text and numeric value disagree
 * (`'-0'`, `'0.'`, leading zeros); re-rendering from `String(parsedNumber)`
 * instead loses that distinction — `String(-0)` is `'0'`, so typing `-0.5`
 * would silently store `0.5` after the second keystroke. See
 * NumberField.test.tsx's keystroke matrix.
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
  const [inputValue, setInputValue] = useState<string | number>(value ?? '')

  // Shows the in-progress text only while it still matches the parent's
  // value; once the parent's value diverges (load, discard, reload), that value wins.
  const displayValue = toNumericValue(inputValue) === value ? inputValue : (value ?? '')

  return (
    <NumberInput
      id={inputId}
      label={label}
      value={displayValue}
      size="sm"
      onChange={(next) => {
        setInputValue(next)
        onChange(toNumericValue(next))
      }}
      data-canopy-field={dataCanopyField}
    />
  )
}
