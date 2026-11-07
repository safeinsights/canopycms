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
}

const VALUE_FORMAT = 'D MMM YYYY'
const REMOVE_LABEL = 'Remove date'

/**
 * Editor for `type: 'date'` fields: a day, stored as `YYYY-MM-DD`, with no time and no zone. Only
 * a pick or Remove writes, so a loaded value saves back unchanged; Remove also clears a value that
 * is no real day, which shows as not set and which a save refuses.
 */
export const DateField: React.FC<DateFieldProps> = ({
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
  const date = calendarDayToLocalDate(value)

  return (
    <LabelledInput label={label} inputId={inputId} canopyPath={dataCanopyField}>
      <DatePickerInput
        ref={triggerRef}
        id={inputId}
        // The label alone would name the trigger; a screen reader also needs the value.
        aria-label={`${label ?? 'Date'}, ${date ? dayjs(date).format(VALUE_FORMAT) : 'not set'}`}
        description={description}
        size="sm"
        value={date}
        onChange={(next) => {
          if (!readOnly && next) onChange(localDateToCalendarDay(next))
        }}
        valueFormat={VALUE_FORMAT}
        placeholder={readOnly ? undefined : 'Pick a date'}
        ariaLabels={CALENDAR_LABELS}
        // Red is for errors here, so weekends look like other days.
        weekendDays={[]}
        rightSection={
          value && !readOnly ? (
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
