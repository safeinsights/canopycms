/**
 * When two content values count as the same, for every comparison of entry versions: the "Show
 * changes" drawer (`editor/entry-diff.ts`) and the field merge (`entry-merge.ts`) both use it, so a
 * value the drawer calls unchanged is one the merge never calls a conflict.
 */

import { ITEM_KEY } from '../item-keys'
import { isPlainRecord } from '../validation/field-traversal'

/** `value`'s own members, `__proto__` included as a member like any other. */
const members = (value: Record<string, unknown>): Array<[string, unknown]> => Object.entries(value)

/** Absent, null, `''`, `[]`, or a record holding nothing but those and an item key. */
export const isEmptyValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isPlainRecord(value) && members(value).every(([k, v]) => k === ITEM_KEY || isEmptyValue(v)))

/** `value` without item keys and empty members, so equal content compares equal. */
export const normalizedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizedValue)
  if (!isPlainRecord(value)) return value
  return Object.fromEntries(
    members(value)
      .filter(([k, v]) => k !== ITEM_KEY && !isEmptyValue(v))
      .map(([k, v]) => [k, normalizedValue(v)]),
  )
}

/** A string naming `value` exactly: equal for two values exactly when they hold the same. */
export const exactToken = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(exactToken).join(',')}]`
  if (value instanceof Date) return `D${value.getTime()}`
  if (isPlainRecord(value)) {
    const sorted = members(value).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    return `{${sorted.map(([k, v]) => `${JSON.stringify(k)}:${exactToken(v)}`).join(',')}}`
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value)
  if (typeof value === 'bigint') return `${value}n`
  return String(value)
}

/**
 * A string naming `value` up to {@link sameValue}: two values share a token exactly when they are
 * the same, so a sequence of values can be aligned as a sequence of strings.
 */
export const valueToken = (value: unknown): string =>
  isEmptyValue(value) ? '' : exactToken(normalizedValue(value))

/** The same content: item keys and empty members aside, and every empty value alike. */
export const sameValue = (a: unknown, b: unknown): boolean => valueToken(a) === valueToken(b)
