import { expect } from 'vitest'

import type { FieldConfig } from '../../config'
import type { DataPathSegment } from '../../editor/entry-diff'
import { ITEM_KEY } from '../../item-keys'
import { findBodyFieldName } from '../../utils/body-field'
import { entryAsRead } from '../../utils/calendar-day'
import { isPlainRecord } from '../../validation/field-traversal'
import type { FieldConflict, MergeSide } from '../entry-merge'
import { sameValue } from '../value-equality'

/** What `read` holds at `path`, an item found by the key a read gives it, as the editor finds it. */
export const valueAtSidePath = (read: unknown, path: readonly DataPathSegment[]): unknown =>
  path.reduce<unknown>((node, segment) => {
    if ('field' in segment) return isPlainRecord(node) ? node[segment.field] : undefined
    if ('item' in segment) {
      return Array.isArray(node)
        ? node.find((item) => isPlainRecord(item) && item[ITEM_KEY] === segment.item)
        : undefined
    }
    return isPlainRecord(node) ? (isPlainRecord(node.value) ? node.value : node) : undefined
  }, read)

/** A version as the API serves it: read, its body under the body field. */
const readOf = (side: MergeSide, fields: readonly FieldConfig[] | undefined): unknown => {
  const data =
    side.body === undefined
      ? side.data
      : { ...side.data, [findBodyFieldName(fields ?? [])]: side.body }
  return fields ? entryAsRead(fields, data) : data
}

/**
 * Asserts each conflict's side paths find, in that version as read, the value the conflict carries
 * for it, and that a version holding a value there has a path to it. Resolves the conflicts without
 * their side paths, for tests about the rest.
 */
export function checkSidePaths(
  conflicts: readonly FieldConflict[],
  sides: { ancestor: MergeSide; base: MergeSide; branch: MergeSide },
  fields: readonly FieldConfig[] | undefined,
): Array<Omit<FieldConflict, 'sidePaths'>> {
  const reads = {
    ancestor: readOf(sides.ancestor, fields),
    base: readOf(sides.base, fields),
    branch: readOf(sides.branch, fields),
  }
  return conflicts.map(({ sidePaths, ...conflict }) => {
    for (const side of ['ancestor', 'base', 'branch'] as const) {
      const path = sidePaths[side]
      const value = conflict[side]
      if (value !== undefined) expect(path, `${conflict.key}: ${side}'s path`).toBeDefined()
      if (path === undefined) continue
      const found = valueAtSidePath(reads[side], path)
      const last = conflict.dataPath.at(-1)
      if (path.length === conflict.dataPath.length - 1 && last && 'item' in last) {
        // One step short of an item: the version's list, which lacks it.
        expect(value, `${conflict.key}: ${side} lacks the item`).toBeUndefined()
        expect(Array.isArray(found), `${conflict.key}: ${side}'s path is a list`).toBe(true)
        continue
      }
      expect(sameValue(found, value), `${conflict.key}: ${side}'s value at its path`).toBe(true)
    }
    return conflict
  })
}
