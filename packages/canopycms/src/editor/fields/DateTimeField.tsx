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
 * Converts a stored value (ISO 8601 UTC, e.g. `YYYY-MM-DDTHH:mm:ss.sssZ`)
 * into the local wall-clock string a `datetime-local` input expects
 * (`YYYY-MM-DDTHH:mm:ss`, no timezone). Returns '' for '' or an unparsable value.
 * @internal Exported for tests.
 */
export function isoToDatetimeLocalValue(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  // Seconds are included only when non-zero, matching a real browser's own
  // `datetime-local` serialization, so the value we set agrees with what the control reports back.
  return date.getSeconds() === 0 ? base : `${base}:${pad(date.getSeconds())}`
}

/**
 * Convert a `datetime-local` input's local wall-clock string back into the
 * ISO 8601 UTC storage format. Returns '' for '' or an unparsable value.
 * @internal Exported for tests.
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
 * Storage format: ISO 8601 UTC string (e.g. `YYYY-MM-DDTHH:mm:ss.sssZ`) — what
 * `Date.prototype.toISOString()` produces and `validation/entry-validator.ts`'s
 * datetime check (`Date.parse`) accepts. Empty string means "not set".
 *
 * Uses a native `datetime-local` input in Mantine's `Input.Wrapper` rather than
 * `@mantine/dates` (not a dependency here) — a real picker with zero new deps.
 *
 * `datetime-local` has no timezone: converts UTC ISO -> local for display and
 * back on change, so an unedited load-then-save round-trips exactly instead of
 * drifting by the browser's offset. `step={1}` preserves seconds in that
 * round-trip; sub-second precision is not preserved (no milliseconds field),
 * so a value with non-zero milliseconds is zeroed out once resaved.
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
