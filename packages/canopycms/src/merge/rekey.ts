/**
 * The field merge's keys, onto what a git-level merge wrote: git keeps each item under its side's
 * key, which can name another item once the other side changed it.
 */

import { ITEM_KEY } from '../item-keys'
import { isPlainRecord } from '../validation/field-traversal'
import { isEmptyValue, valueToken } from './value-equality'

const owns = (record: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, name)

const isRecordList = (value: unknown): value is Array<Record<string, unknown>> =>
  Array.isArray(value) && value.length > 0 && value.every(isPlainRecord)

/** `value`'s content with item keys aside and each list of records in any order. */
const looseToken = (value: unknown): string => {
  if (isEmptyValue(value)) return ''
  if (isRecordList(value)) return `[${value.map(looseToken).sort().join(',')}]`
  if (!isPlainRecord(value)) return valueToken(value)
  const members = Object.entries(value)
    .filter(([name, v]) => name !== ITEM_KEY && !isEmptyValue(v))
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  return `{${members.map(([name, v]) => `${JSON.stringify(name)}:${looseToken(v)}`).join(',')}}`
}

/**
 * `merged` with each list item under the key `fieldMerged` gives the item holding its content, in
 * `merged`'s order, alike items matched in order; nested lists alike. Undefined where the two don't
 * hold the same content, item keys and the order of list items aside. A list of plain values is
 * content in its order.
 */
export function rekeyAsMerged(merged: unknown, fieldMerged: unknown): unknown {
  if (isRecordList(merged) && isRecordList(fieldMerged)) {
    if (merged.length !== fieldMerged.length) return undefined
    const pool = fieldMerged.map((item) => ({ item, token: looseToken(item) }))
    const out: unknown[] = []
    for (const item of merged) {
      const token = looseToken(item)
      const at = pool.findIndex((p) => p.token === token)
      if (at === -1) return undefined
      const [{ item: match }] = pool.splice(at, 1)
      const rekeyed = rekeyAsMerged(item, match)
      if (rekeyed === undefined) return undefined
      out.push(rekeyed)
    }
    return out
  }
  if (isPlainRecord(merged) && isPlainRecord(fieldMerged)) {
    // Git's members in git's order, so the text changes only where a key does.
    const out: Array<[string, unknown]> = []
    const key = owns(fieldMerged, ITEM_KEY) ? fieldMerged[ITEM_KEY] : undefined
    for (const [name, value] of Object.entries(merged)) {
      if (name === ITEM_KEY) {
        if (key !== undefined) out.push([name, key])
        continue
      }
      const other = owns(fieldMerged, name) ? fieldMerged[name] : undefined
      const rekeyed =
        isEmptyValue(value) && isEmptyValue(other) ? value : rekeyAsMerged(value, other)
      if (rekeyed === undefined) return undefined
      out.push([name, rekeyed])
    }
    for (const [name, value] of Object.entries(fieldMerged)) {
      if (owns(merged, name)) continue
      if (name === ITEM_KEY) out.push([name, value])
      else if (!isEmptyValue(value)) return undefined
    }
    return Object.fromEntries(out)
  }
  return valueToken(merged) === valueToken(fieldMerged) ? merged : undefined
}
