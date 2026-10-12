import React, { useId } from 'react'

import { DateTimePicker } from '@mantine/dates'

import { LabelledInput } from './FieldLabel'

export interface DateTimeFieldProps {
  id?: string
  label?: string
  description?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
}

/** The stored ISO string as a Date, or null for '' or an unparsable value. */
const toDate = (iso: string): Date | null => {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Editor for `type: 'datetime'` fields, a Mantine `DateTimePicker` in the browser's time zone.
 *
 * Storage format: ISO 8601 UTC string (e.g. `YYYY-MM-DDTHH:mm:ss.sssZ`) — what
 * `Date.prototype.toISOString()` produces and `validation/entry-validator.ts`'s
 * datetime check (`Date.parse`) accepts. Empty string means "not set".
 *
 * Only a pick writes, so a loaded value saves back unchanged, unparsable ones included. A pick
 * keeps seconds (`withSeconds`).
 */
export const DateTimeField: React.FC<DateTimeFieldProps> = ({
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
    <LabelledInput label={label} inputId={inputId} canopyPath={dataCanopyField}>
      <DateTimePicker
        id={inputId}
        description={description}
        size="sm"
        value={toDate(value)}
        onChange={(next) => {
          if (!readOnly) onChange(next ? next.toISOString() : '')
        }}
        withSeconds
        valueFormat="D MMM YYYY, HH:mm:ss"
        placeholder={readOnly ? undefined : 'Pick a date and time'}
        clearable={!readOnly}
        clearButtonProps={{ 'aria-label': 'Clear date and time' }}
        readOnly={readOnly}
        data-canopy-field={dataCanopyField}
      />
    </LabelledInput>
  )
}
