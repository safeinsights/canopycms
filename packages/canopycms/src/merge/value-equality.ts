/**
 * When two content values count as the same, for every comparison of entry versions: the "Show
 * changes" drawer (`editor/entry-diff.ts`) and the field merge (`entry-merge.ts`) both use it, so a
 * value the drawer calls unchanged is one the merge never calls a conflict.
 */

import equal from 'fast-deep-equal'

import { ITEM_KEY } from '../item-keys'
import { isPlainRecord } from '../validation/field-traversal'

/** Absent, null, `''`, `[]`, or a record holding nothing but those and an item key. */
export const isEmptyValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isPlainRecord(value) &&
    Object.keys(value).every((k) => k === ITEM_KEY || isEmptyValue(value[k])))

/** `value` without item keys and empty members, so equal content compares equal. */
export const normalizedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizedValue)
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k !== ITEM_KEY && !isEmptyValue(v)) out[k] = normalizedValue(v)
  }
  return out
}

export const sameValue = (a: unknown, b: unknown): boolean =>
  (isEmptyValue(a) && isEmptyValue(b)) || equal(normalizedValue(a), normalizedValue(b))

const tokenOf = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(tokenOf).join(',')}]`
  if (value instanceof Date) return `D${value.getTime()}`
  if (isPlainRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${tokenOf(value[k])}`)
    return `{${members.join(',')}}`
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
  isEmptyValue(value) ? '' : tokenOf(normalizedValue(value))
