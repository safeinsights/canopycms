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

/** The fields inside a value of `field`, when it is a record the drawer walks by schema. */
const fieldsInside = (field: FieldConfig | undefined): readonly FieldConfig[] | undefined =>
  field?.type === 'object' && !(field as ObjectFieldConfig).list
    ? ((field as ObjectFieldConfig).fields ?? [])
    : undefined

/**
 * `at`, a path through `read` (the merged data as a read gives it, so items carry the keys the
 * drawer names them by), as the drawer's key and data path.
 */
export function describePath(
  fields: readonly FieldConfig[] | undefined,
  read: unknown,
  at: readonly RawSegment[],
): { key: string; dataPath: DataPathSegment[] } {
  let key = ''
  const dataPath: DataPathSegment[] = []
  let scope: readonly FieldConfig[] | undefined = fields ?? []
  let field: FieldConfig | undefined
  let node: unknown = read
  // The list field whose item `node` is, while no member of that item has been entered yet.
  let itemOf: { field: FieldConfig | undefined } | undefined
  for (const segment of at) {
    if (!('field' in segment)) {
      const items = Array.isArray(node) ? node : []
      const itemKey =
        'item' in segment
          ? segment.item
          : (itemKeysAsRead(items)[segment.index] ?? String(segment.index))
      key = `${key}.${itemKey}`
      dataPath.push({ item: itemKey })
      itemOf = { field }
      node = 'index' in segment ? items[segment.index] : undefined
      scope = field?.type === 'object' ? ((field as ObjectFieldConfig).fields ?? []) : undefined
      continue
    }
    const name = segment.field
    if (itemOf && itemOf.field?.type !== 'object' && isPlainRecord(node)) {
      // A block item: canonical `{ template, value }`, or inline `{ _type, ...data }`.
      const template = typeof node.template === 'string' ? node.template : undefined
      const inline =
        template === undefined && typeof node._type === 'string' ? node._type : undefined
      const templateFields =
        itemOf.field?.type === 'block'
          ? (itemOf.field as BlockFieldConfig).templates.find(
              (t) => t.name === (template ?? inline),
            )?.fields
          : undefined
      if (template !== undefined && name === 'value') {
        dataPath.push({ blockData: true })
        node = node.value
        scope = templateFields
        itemOf = undefined
        continue
      }
      if (inline !== undefined && !isBlockStructuralKey(name)) {
        dataPath.push({ blockData: true })
        scope = templateFields
      }
    }
    itemOf = undefined
    field = fieldNamed(scope, name)
    key = field ? (key ? `${key}.${name}` : name) : `${key}?${name}`
    dataPath.push({ field: name })
    node = isPlainRecord(node) ? node[name] : undefined
    scope = fieldsInside(field)
  }
  return { key, dataPath }
}
