/**
 * Names a place in a merged entry the way the "Show changes" drawer (`editor/entry-diff.ts`) names
 * its changes, so a conflict and the drawer's change at the same place share `key` and
 * `dataPath`: a field the schema knows joins the key with `.`, one it doesn't with `?`, a list item
 * is named by its key as a read gives it, and a block's data is a `blockData` step.
 */

import type { BlockFieldConfig, FieldConfig, ObjectFieldConfig } from '../config'
import type { DataPathSegment } from '../editor/entry-diff'
import { itemKeysAsRead } from '../item-keys'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { isBlockStructuralKey } from '../validation/block-structural-keys'
import { isPlainRecord } from '../validation/field-traversal'

/**
 * A step the merge took: a record's member, a merged list's item by its place, or, for an item no
 * longer in the merged list, the key naming it.
 */
export type RawSegment = { field: string } | { index: number } | { item: string }

const fieldNamed = (
  scope: readonly FieldConfig[] | undefined,
  name: string,
): FieldConfig | undefined => scope && flattenGroupFields(scope).find((f) => f.name === name)

const member = (node: unknown, name: string): unknown =>
  isPlainRecord(node) && Object.prototype.hasOwnProperty.call(node, name) ? node[name] : undefined

const readKeys = new WeakMap<readonly unknown[], Array<string | undefined>>()

/** The key a read gives each item of `items`, worked out once per list. */
const keysOf = (items: readonly unknown[]): Array<string | undefined> => {
  let keys = readKeys.get(items)
  if (!keys) readKeys.set(items, (keys = itemKeysAsRead(items)))
  return keys
}

/**
 * `at`, a path through `read` (the merged data as a read gives it, so items carry the keys the
 * drawer names them by), as the drawer's key and data path. The drawer goes into a record the
 * schema describes, an object list's items and a block whose template resolves; anywhere else it
 * shows the whole value, so a deeper path is named there: `depth` is how many steps of `at` the
 * name covers. `field` is the schema's field at the end of the whole path, when the schema reaches
 * that far.
 */
export function describePath(
  fields: readonly FieldConfig[] | undefined,
  read: unknown,
  at: readonly RawSegment[],
): { key: string; dataPath: DataPathSegment[]; depth: number; field?: FieldConfig } {
  let key = ''
  const dataPath: DataPathSegment[] = []
  let scope: readonly FieldConfig[] = fields ?? []
  let list: FieldConfig | undefined
  let mode: 'record' | 'list' | 'block' = 'record'
  let field: FieldConfig | undefined
  let node: unknown = read
  let n = 0
  walk: for (; n < at.length; n++) {
    const segment = at[n]
    if (mode === 'list') {
      if ('field' in segment) break
      const items = Array.isArray(node) ? node : []
      const itemKey =
        'item' in segment ? segment.item : (keysOf(items)[segment.index] ?? String(segment.index))
      key = `${key}.${itemKey}`
      dataPath.push({ item: itemKey })
      node = 'index' in segment ? items[segment.index] : undefined
      field = undefined
      if (list?.type === 'object') {
        scope = (list as ObjectFieldConfig).fields ?? []
        mode = 'record'
      } else {
        mode = 'block'
      }
      continue
    }
    if (!('field' in segment)) break
    if (mode === 'block') {
      // A block item: canonical `{ template, value }`, or inline `{ _type, ...data }`.
      const template = member(node, 'template')
      const inline = member(node, '_type')
      const name = typeof template === 'string' ? template : inline
      const templateFields = (list as BlockFieldConfig).templates.find(
        (t) => t.name === name,
      )?.fields
      if (!templateFields || isBlockStructuralKey(segment.field)) break
      dataPath.push({ blockData: true })
      scope = templateFields
      mode = 'record'
      if (typeof template === 'string') {
        if (segment.field !== 'value') break
        node = member(node, 'value')
        continue
      }
    }
    const name = segment.field
    field = fieldNamed(scope, name)
    key = field ? (key ? `${key}.${name}` : name) : `${key}?${name}`
    dataPath.push({ field: name })
    node = member(node, name)
    if (!field) {
      n++
      break walk
    }
    if (field.type === 'object' && !(field as ObjectFieldConfig).list) {
      scope = (field as ObjectFieldConfig).fields ?? []
    } else if (field.type === 'object' || field.type === 'block') {
      list = field
      mode = 'list'
    } else {
      n++
      break walk
    }
  }
  return { key, dataPath, depth: n, ...(n === at.length && field && { field }) }
}
