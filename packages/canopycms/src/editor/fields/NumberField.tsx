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
 * `undefined` means "not filled in" and is distinct from `0`: an empty
 * input must not silently become `0` (that would make a required numeric
 * field with value `0` look correct while an actually-empty field also
 * looks fine), and `0` must not be mistaken for "absent". Mantine's
 * `NumberInput` reports an empty input as `''`; we translate that to
 * `undefined` so `validation/entry-validator.ts`'s required check (which
 * treats only `undefined`/`null` as empty for numbers) agrees with what the
 * form displays.
 *
 * IN-PROGRESS TEXT IS MIRRORED BACK, NOT THE PARSED NUMBER, and that is
 * load-bearing rather than stylistic. Mantine reports an entry as a STRING
 * exactly when the text and its numeric value disagree (`'-0'`, `'0.'`,
 * `'-0.0'`, leading zeros) and as a number otherwise. Handing the PARSED
 * number back as the controlled value re-renders the input from
 * `String(number)` — and `String(-0)` is `'0'`, so typing `-0.5` lost its
 * minus after the second keystroke and the `.5` appended to a POSITIVE
 * zero: the user typed `-0.5` and `0.5` was stored, silently. Keeping the
 * text Mantine itself reported keeps the sign on screen until the entry is
 * a complete number. See NumberField.test.tsx's keystroke matrix.
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

  // Show the in-progress text only while it still means what the parent
  // holds. Once the parent's value diverges (entry loaded, draft discarded,
  // "Reload File"), that value wins and the stale text is dropped.
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

export default NumberField
