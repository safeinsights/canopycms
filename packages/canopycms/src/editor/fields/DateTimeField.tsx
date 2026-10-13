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

const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})([Tt ]|$)/

/** Whether the written year, month and day name a real day; `Date` rolls 30 Feb on to 1 Mar. */
const isCalendarDate = (year: number, month: number, day: number): boolean => {
  const lastOfMonth = new Date(0)
  lastOfMonth.setUTCFullYear(year, month, 0)
  return month >= 1 && month <= 12 && day >= 1 && day <= lastOfMonth.getUTCDate()
}

/**
 * The stored value as a Date, or null for '', an unparsable value or a day that does not exist. A
 * date-only value is local midnight; `Date` reads UTC midnight, the evening before west of UTC.
 */
const toDate = (iso: string): Date | null => {
  if (!iso) return null
  const datePart = DATE_PART.exec(iso)
  if (datePart) {
    const [year, month, day] = datePart.slice(1, 4).map(Number)
    if (!isCalendarDate(year, month, day)) return null
    if (datePart[4] === '') {
      // setFullYear, since the constructor maps years 0-99 to 1900-1999.
      const local = new Date(0)
      local.setFullYear(year, month - 1, day)
      local.setHours(0, 0, 0, 0)
      return local
    }
  }
  const date = new Date(iso)
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
 * Only a pick or Remove writes, so a loaded value, date-only or unparsable, saves back unchanged.
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
