import React, { useId, useRef } from 'react'

import { ActionIcon, Tooltip } from '@mantine/core'
import { DatePickerInput } from '@mantine/dates'
import { IconX } from '@tabler/icons-react'
import dayjs from 'dayjs'

import { calendarDayToLocalDate, localDateToCalendarDay } from '../../utils/calendar-day'
import { CALENDAR_LABELS } from './DateTimeField'
import { LabelledInput } from './FieldLabel'

export interface DateFieldProps {
  id?: string
  label?: string
  description?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
  /** Shows the value without accepting edits. */
  readOnly?: boolean
  /** A required field has no Remove: a save needs a day in it. */
  required?: boolean
}

const VALUE_FORMAT = 'D MMM YYYY'
const REMOVE_LABEL = 'Remove date'

/** What a stored value that is no real day says: it is the only clue to the day meant. */
const notADay = (value: string, readOnly: boolean, required: boolean): string => {
  const next = required ? 'Pick a date.' : 'Pick a date or remove it.'
  return `Stored as “${value}”, which isn't a real date.${readOnly ? '' : ` ${next}`}`
}

/**
 * Editor for `type: 'date'` fields: a day, stored as `YYYY-MM-DD`, with no time and no zone. Only
 * a pick or Remove writes, so a loaded value saves back unchanged, and a save refuses one that is
 * no real day.
 */
export const DateField: React.FC<DateFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
  readOnly = false,
  required = false,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const triggerRef = useRef<HTMLButtonElement>(null)
  const date = calendarDayToLocalDate(value)
  const invalid = value !== '' && date === null
  const shown = date ? dayjs(date).format(VALUE_FORMAT) : invalid ? 'invalid value' : 'not set'

  return (
    <LabelledInput label={label} inputId={inputId} canopyPath={dataCanopyField}>
      <DatePickerInput
        ref={triggerRef}
        id={inputId}
        // The label alone would name the trigger; a screen reader also needs the value.
        aria-label={`${label ?? 'Date'}, ${shown}`}
        description={description}
        error={invalid ? notADay(value, readOnly, required) : undefined}
        size="sm"
        value={date}
        onChange={(next) => {
          if (readOnly || !next) return
          onChange(localDateToCalendarDay(next))
          // The day unmounts under focus, which would drop a keyboard user to the page.
          triggerRef.current?.focus()
        }}
        valueFormat={VALUE_FORMAT}
        placeholder={readOnly ? undefined : 'Pick a date'}
        ariaLabels={CALENDAR_LABELS}
        // Red is for errors here, so weekends look like other days.
        weekendDays={[]}
        rightSection={
          value && !readOnly && !required ? (
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
