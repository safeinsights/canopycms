import React, { useId, useRef } from 'react'

import { ActionIcon, Tooltip } from '@mantine/core'
import { DateTimePicker } from '@mantine/dates'
import { IconX } from '@tabler/icons-react'
import dayjs from 'dayjs'

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

/** Whether the locale uses a 12-hour clock, as the dropdown's native time input then does. */
const usesTwelveHourClock = (): boolean => {
  const { hour12, hourCycle } = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
  }).resolvedOptions()
  return hour12 ?? (hourCycle === 'h11' || hourCycle === 'h12')
}

const valueFormat = (): string => `D MMM YYYY, ${usesTwelveHourClock() ? 'h:mm:ss A' : 'HH:mm:ss'}`
const REMOVE_LABEL = 'Remove date and time'

// The picker's own controls are icon-only or unlabelled without these.
const CALENDAR_LABELS = {
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  previousYear: 'Previous year',
  nextYear: 'Next year',
  previousDecade: 'Previous decade',
  nextDecade: 'Next decade',
  monthLevelControl: 'Choose a month',
  yearLevelControl: 'Choose a year',
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * The stored ISO string as a Date, or null for '' or an unparsable value. A date-only value is
 * local midnight; `Date` reads it as UTC midnight, the previous evening west of UTC.
 */
const toDate = (iso: string): Date | null => {
  if (!iso) return null
  const dateOnly = DATE_ONLY.exec(iso)
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The browser's zone as it abbreviates it ("MDT"), which the field shows times in. */
const zoneName = (at: Date): string | undefined =>
  new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value

/**
 * Editor for `type: 'datetime'` fields, a Mantine `DateTimePicker` in the browser's time zone,
 * which its description names.
 *
 * Storage format: ISO 8601 UTC string (e.g. `YYYY-MM-DDTHH:mm:ss.sssZ`) — what
 * `Date.prototype.toISOString()` produces and `validation/entry-validator.ts`'s
 * datetime check (`Date.parse`) accepts. Empty string means "not set".
 *
 * Only a pick or Remove writes, so a loaded value saves back unchanged, unparsable ones included.
 * A pick keeps seconds (`withSeconds`).
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const date = toDate(value)
  const zone = zoneName(date ?? new Date())
  const zoneNote = zone ? `In your time zone (${zone}).` : undefined
  const format = valueFormat()

  return (
    <LabelledInput label={label} inputId={inputId} canopyPath={dataCanopyField}>
      <DateTimePicker
        ref={triggerRef}
        id={inputId}
        // The label alone would name the trigger; a screen reader also needs the value.
        aria-label={`${label ?? 'Date and time'}, ${date ? dayjs(date).format(format) : 'not set'}`}
        description={[description, zoneNote].filter(Boolean).join(' ') || undefined}
        size="sm"
        value={date}
        onChange={(next) => {
          if (!readOnly) onChange(next ? next.toISOString() : '')
        }}
        withSeconds
        valueFormat={format}
        placeholder={readOnly ? undefined : 'Pick a date and time'}
        ariaLabels={CALENDAR_LABELS}
        timeInputProps={{ 'aria-label': 'Time' }}
        submitButtonProps={{ 'aria-label': 'Done' }}
        // Red is for errors here, so weekends look like other days.
        weekendDays={[]}
        rightSection={
          date && !readOnly ? (
            <Tooltip label={REMOVE_LABEL}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={REMOVE_LABEL}
                onClick={() => {
                  onChange('')
                  // The control goes with the value, so focus returns to the field.
                  triggerRef.current?.focus()
                }}
              >
                <IconX size={14} aria-hidden />
              </ActionIcon>
            </Tooltip>
          ) : undefined
        }
        rightSectionPointerEvents="all"
        readOnly={readOnly}
        data-canopy-field={dataCanopyField}
      />
    </LabelledInput>
  )
}
