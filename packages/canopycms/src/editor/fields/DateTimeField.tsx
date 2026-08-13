import React, { useId } from 'react'

import { Input } from '@mantine/core'

export interface DateTimeFieldProps {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
}

/**
 * Convert a stored value (ISO 8601 UTC, e.g. "2024-03-15T14:30:00.000Z")
 * into the "local wall-clock" string a `datetime-local` input expects
 * (`YYYY-MM-DDTHH:mm:ss`, no timezone). Returns '' for '' or an unparsable
 * value.
 */
export function isoToDatetimeLocalValue(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  // Match the platform's own canonical `datetime-local` serialization: the
  // seconds component is included only when non-zero (a real browser's
  // input.value getter does the same), so the value we set and what the
  // control reports back agree exactly.
  return date.getSeconds() === 0 ? base : `${base}:${pad(date.getSeconds())}`
}

/**
 * Convert a `datetime-local` input's local wall-clock string back into the
 * ISO 8601 UTC storage format. Returns '' for '' or an unparsable value.
 */
export function datetimeLocalValueToIso(local: string): string {
  if (!local) return ''
  const date = new Date(local)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

/**
 * Editor for `type: 'datetime'` fields.
 *
 * Storage format: ISO 8601 UTC string (e.g. "2024-03-15T14:30:00.000Z") —
 * what `Date.prototype.toISOString()` produces and what
 * `validation/entry-validator.ts`'s datetime check (`Date.parse`) accepts.
 * Empty string means "not set" (matches entry-validator's empty-string
 * check for required fields).
 *
 * `@mantine/dates` is not a dependency of this package, so per house rules
 * we don't add one just for this field: a native `<input
 * type="datetime-local">` wrapped in Mantine's `Input`/`Input.Wrapper`
 * gives a real date+time picker with zero new dependencies.
 *
 * `datetime-local` has no timezone concept — it shows/accepts local
 * "wall-clock" time. We convert UTC ISO -> local for display and local ->
 * UTC ISO on change, so loading a value and saving it unedited round-trips
 * to the exact same stored string instead of drifting by the browser's UTC
 * offset. `step={1}` keeps seconds in that round trip; sub-second
 * precision in the source data is not preserved (`datetime-local` has no
 * milliseconds field), so a stored value with non-zero milliseconds will
 * have them zeroed out once resaved.
 */
export const DateTimeField: React.FC<DateTimeFieldProps> = ({
  id,
  label,
  value,
  onChange,
  dataCanopyField,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <Input.Wrapper id={inputId} label={label} size="sm">
      <Input
        type="datetime-local"
        step={1}
        size="sm"
        value={isoToDatetimeLocalValue(value)}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          onChange(datetimeLocalValueToIso(e.currentTarget.value))
        }
        data-canopy-field={dataCanopyField}
      />
    </Input.Wrapper>
  )
}

export default DateTimeField
