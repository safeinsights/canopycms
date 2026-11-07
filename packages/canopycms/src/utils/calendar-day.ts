import type {
  BlockFieldConfig,
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
} from '../config'
import { withItemKeys } from '../item-keys'
import { isPlainRecord, resolveBlockItem } from '../validation/field-traversal'

/**
 * The value of a `date` field: `YYYY-MM-DD`, a day on the calendar with no time and no zone. It
 * only meets a `Date` at the two edges, a picker and a YAML parser, and there it goes through the
 * local or the UTC parts named below, never from one to the other.
 */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const MS_PER_DAY = 86_400_000

const twoDigits = (n: number): string => String(n).padStart(2, '0')

/** Whether the year, month and day name a real day; `Date` rolls 30 Feb on to 1 Mar. */
export const isRealDay = (year: number, month: number, day: number): boolean => {
  const lastOfMonth = new Date(0)
  lastOfMonth.setUTCFullYear(year, month, 0)
  return month >= 1 && month <= 12 && day >= 1 && day <= lastOfMonth.getUTCDate()
}

const dayParts = (value: unknown): [number, number, number] | undefined => {
  const match = typeof value === 'string' ? DAY.exec(value) : null
  if (!match) return undefined
  const [year, month, day] = match.slice(1).map(Number)
  return isRealDay(year, month, day) ? [year, month, day] : undefined
}

/** Whether `value` is a `date` field's value: `YYYY-MM-DD`, naming a real day. */
export const isCalendarDay = (value: unknown): value is string => dayParts(value) !== undefined

/**
 * The first moment of that day in the browser's zone: 01:00 where a clock change skips midnight.
 * `new Date('YYYY-MM-DD')` is UTC midnight instead, the evening before west of UTC.
 */
export const localMidnight = (year: number, month: number, day: number): Date => {
  // setFullYear, since the constructor maps years 0-99 to 1900-1999.
  const local = new Date(0)
  local.setFullYear(year, month - 1, day)
  local.setHours(0, 0, 0, 0)
  return local
}

/** A `date` value as a picker's local `Date`, or null when it is not a real day. */
export const calendarDayToLocalDate = (value: string): Date | null => {
  const parts = dayParts(value)
  return parts ? localMidnight(...parts) : null
}

/** The day a picker's local `Date` shows, as a `date` value. */
export const localDateToCalendarDay = (date: Date): string =>
  `${String(date.getFullYear()).padStart(4, '0')}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`

/**
 * The day gray-matter's js-yaml reads a bare `YYYY-MM-DD` as, or undefined for a time of day. js-yaml
 * reads it as UTC midnight, so the UTC parts are the day written whatever the machine's zone.
 */
const dayOfBareDate = (value: Date): string | undefined =>
  value.getTime() % MS_PER_DAY === 0 ? value.toISOString().slice(0, 10) : undefined

const mapItems = (
  items: readonly unknown[],
  mapItem: (item: Record<string, unknown>) => Record<string, unknown>,
): readonly unknown[] => {
  const next = items.map((item) => (isPlainRecord(item) ? mapItem(item) : item))
  return next.every((item, i) => item === items[i]) ? items : next
}

const blockItemWithDays = (
  field: BlockFieldConfig,
  item: Record<string, unknown>,
): Record<string, unknown> => {
  const resolved = resolveBlockItem(field, item)
  if (!resolved) return item
  const data = withCalendarDays(resolved.fields, resolved.data)
  if (data === resolved.data) return item
  return resolved.data === item ? data : { ...item, value: data }
}

const valueWithDays = (field: FieldConfig, value: unknown): unknown => {
  if (field.type === 'date') {
    return value instanceof Date ? (dayOfBareDate(value) ?? value) : value
  }
  if (field.type === 'object') {
    const { fields, list } = field as ObjectFieldConfig
    if (list) {
      return Array.isArray(value)
        ? mapItems(value, (item) => withCalendarDays(fields ?? [], item))
        : value
    }
    return isPlainRecord(value) ? withCalendarDays(fields ?? [], value) : value
  }
  if (field.type === 'block' && Array.isArray(value)) {
    return mapItems(value, (item) => blockItemWithDays(field as BlockFieldConfig, item))
  }
  return value
}

/**
 * `data` with each `date` field's bare YAML date as its `YYYY-MM-DD` string, nested fields
 * included; the same object when none needed it, so a parser's shared object is never written to.
 * Only the schema knows a field wants a day, so other fields' bare dates stay `Date`s.
 */
export function withCalendarDays(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  let out = data
  for (const field of fields) {
    if (field.type === 'group') {
      out = withCalendarDays((field as InlineGroupFieldConfig).fields, out)
      continue
    }
    const value = out[field.name]
    const next = valueWithDays(field, value)
    if (next !== value) out = { ...out, [field.name]: next }
  }
  return out
}

/** `data` parsed from an entry file as every reader hands it on, so all of them agree. */
export const entryAsRead = (
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
): Record<string, unknown> => withItemKeys(fields, withCalendarDays(fields, data), 'content')
