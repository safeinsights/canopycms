import type {
  BlockFieldConfig,
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
} from '../config'
import { isPlainRecord } from '../validation/field-traversal'
import type { CanopyPathSegment } from './canopy-path'

/**
 * What a form's Remove took out, for Undo. Paths are canopy paths (`blocks[2].items`), which skip
 * a block's `value` wrapper; `restoreRemoval` resolves them against the value it restores into.
 */
/**
 * One list a removal sits inside (a block list, or an object list holding the removed item's
 * list): the index of the item enclosing the removal, and every other item, by identity.
 */
export interface RemovalAnchor {
  index: number
  siblings: unknown[]
}

export type FieldRemoval = (
  | {
      kind: 'list-item'
      /** The list field's own path. */
      listPath: CanopyPathSegment[]
      index: number
      /** The removed item itself, so its list-item key comes back with it. */
      item: unknown
      /** Names the item in the Undo toast. */
      label: string
    }
  | { kind: 'value'; path: CanopyPathSegment[]; value: unknown; label: string }
) & {
  /**
   * The enclosing lists as they were before the removal (`removalAnchors`). Undo puts nothing
   * back once one has changed, so an item never lands in whichever block now holds its index.
   */
  anchors?: RemovalAnchor[]
}

const findField = (fields: readonly FieldConfig[], name: string): FieldConfig | undefined => {
  for (const field of fields) {
    if (field.type === 'group') {
      const inGroup = findField((field as InlineGroupFieldConfig).fields, name)
      if (inGroup) return inGroup
    } else if (field.name === name) {
      return field
    }
  }
  return undefined
}

/**
 * The path into the stored value for a canopy path, with the enclosing lists it passes through,
 * or undefined when the value no longer has it.
 */
const resolvePath = (
  fields: readonly FieldConfig[],
  value: unknown,
  path: readonly CanopyPathSegment[],
): { path: CanopyPathSegment[]; anchors: RemovalAnchor[] } | undefined => {
  let scope = fields
  let node = value
  const out: CanopyPathSegment[] = []
  const anchors: RemovalAnchor[] = []
  const anchor = (list: unknown[], index: number) =>
    anchors.push({ index, siblings: list.filter((_, i) => i !== index) })
  let i = 0
  while (i < path.length) {
    const name = path[i]
    const field = typeof name === 'string' ? findField(scope, name) : undefined
    if (typeof name !== 'string' || !field) return undefined
    out.push(name)
    node = isPlainRecord(node) ? node[name] : undefined
    i += 1
    if (i === path.length) return { path: out, anchors }
    const index = path[i]
    if (field.type === 'block') {
      const block = typeof index === 'number' && Array.isArray(node) ? node[index] : undefined
      if (typeof index !== 'number' || !isPlainRecord(block)) return undefined
      const template = (field as BlockFieldConfig).templates.find((t) => t.name === block.template)
      if (!template || !Array.isArray(node)) return undefined
      anchor(node, index)
      out.push(index, 'value')
      node = block.value
      scope = template.fields
      i += 1
    } else if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      if (objectField.list) {
        if (typeof index !== 'number' || !Array.isArray(node)) return undefined
        anchor(node, index)
        out.push(index)
        node = node[index]
        i += 1
      }
      scope = objectField.fields
    } else {
      return undefined
    }
  }
  return { path: out, anchors }
}

const getAt = (root: unknown, path: readonly CanopyPathSegment[]): unknown =>
  path.reduce<unknown>((node, segment) => {
    if (typeof segment === 'number') return Array.isArray(node) ? node[segment] : undefined
    return isPlainRecord(node) ? node[segment] : undefined
  }, root)

const setAt = (root: unknown, path: readonly CanopyPathSegment[], next: unknown): unknown => {
  if (path.length === 0) return next
  const [head, ...rest] = path
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...root] : []
    list[head] = setAt(list[head], rest, next)
    return list
  }
  const record = isPlainRecord(root) ? root : {}
  return { ...record, [head]: setAt(record[head], rest, next) }
}

const removalPath = (removal: FieldRemoval): CanopyPathSegment[] =>
  removal.kind === 'list-item' ? removal.listPath : removal.path

const anchorsHold = (
  then: readonly RemovalAnchor[] | undefined,
  now: readonly RemovalAnchor[],
): boolean =>
  then === undefined ||
  (then.length === now.length &&
    then.every(
      (anchor, i) =>
        anchor.index === now[i].index &&
        anchor.siblings.length === now[i].siblings.length &&
        anchor.siblings.every((sibling, j) => sibling === now[i].siblings[j]),
    ))

/** The enclosing lists of a removal in `value`, taken before the removal applies; see `anchors`. */
export function removalAnchors(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  removal: FieldRemoval,
): RemovalAnchor[] | undefined {
  return resolvePath(fields, value, removalPath(removal))?.anchors
}

/**
 * `value` with a removal put back, or undefined when it can't be: the list or field is gone, an
 * enclosing list has changed, the item is already there, or the image field has been filled. Edits made after the removal are kept, because it
 * changes only the one list or field, in the value as it is now.
 */
export function restoreRemoval(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  removal: FieldRemoval,
): Record<string, unknown> | undefined {
  const resolved = resolvePath(fields, value, removalPath(removal))
  if (!resolved || !anchorsHold(removal.anchors, resolved.anchors)) return undefined
  const { path } = resolved
  const current = getAt(value, path)
  let next: unknown
  if (removal.kind === 'list-item') {
    if (current !== undefined && current !== null && !Array.isArray(current)) return undefined
    // Already back (a Discard or Reload restored it, or an earlier Undo did).
    if (Array.isArray(current) && current.includes(removal.item)) return undefined
    const list = Array.isArray(current) ? [...current] : []
    list.splice(Math.min(removal.index, list.length), 0, removal.item)
    next = list
  } else {
    if (current !== undefined && current !== null) return undefined
    next = removal.value
  }
  const restored = setAt(value, path, next)
  return isPlainRecord(restored) ? restored : undefined
}
