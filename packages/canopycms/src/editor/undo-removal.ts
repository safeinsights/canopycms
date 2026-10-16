import type {
  BlockFieldConfig,
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
} from '../config'
import equal from 'fast-deep-equal'

import type { CommentThread } from '../comment-store'
import { ITEM_KEY, isItemKey } from '../item-keys'
import { isPlainRecord } from '../validation/field-traversal'
import { normalizeCanopyPath, parseCanopyPath, type CanopyPathSegment } from './canopy-path'

/**
 * One list a removal sits inside (a block list, or an object list holding the removed item's
 * list): the index of the item enclosing the removal, and that item's `ITEM_KEY`, which an edit
 * or a move keeps. An item with no usable key is anchored by every other item's content instead.
 */
export type RemovalAnchor = { index: number } & (
  | { key: string; siblings?: never }
  | { key?: never; siblings: unknown[] }
)

/** An enclosing list as it is: the list itself and the index the path takes through it. */
interface EnclosingList {
  list: unknown[]
  index: number
}

const itemKeyAt = (list: readonly unknown[], index: number): string | undefined => {
  const item = list[index]
  const key = isPlainRecord(item) ? item[ITEM_KEY] : undefined
  return isItemKey(key) ? key : undefined
}

/**
 * What a form's Remove took out, for Undo. Paths are canopy paths (`blocks[2].items`), which skip
 * a block's `value` wrapper; `restoreRemoval` resolves them against the value it restores into.
 */
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
   * back once another item holds an enclosing index, so an item never lands in whichever block
   * now holds it; an edit to any item keeps a keyed anchor.
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
): { path: CanopyPathSegment[]; lists: EnclosingList[] } | undefined => {
  let scope = fields
  let node = value
  const out: CanopyPathSegment[] = []
  const lists: EnclosingList[] = []
  const anchor = (list: unknown[], index: number) => lists.push({ list, index })
  let i = 0
  while (i < path.length) {
    const name = path[i]
    const field = typeof name === 'string' ? findField(scope, name) : undefined
    if (typeof name !== 'string' || !field) return undefined
    out.push(name)
    node = isPlainRecord(node) ? node[name] : undefined
    i += 1
    if (i === path.length) return { path: out, lists }
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
  return { path: out, lists }
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

/** Equal once stored: JSON drops `undefined` keys, as the server's copy of a draft does. */
const sameContent = (a: unknown, b: unknown): boolean =>
  equal(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)))

const removalPath = (removal: FieldRemoval): CanopyPathSegment[] =>
  removal.kind === 'list-item' ? removal.listPath : removal.path

const anchorsHold = (
  then: readonly RemovalAnchor[] | undefined,
  now: readonly EnclosingList[],
): boolean =>
  then === undefined ||
  (then.length === now.length &&
    then.every((anchor, i) => {
      const { list, index } = now[i]
      if (anchor.index !== index) return false
      if (anchor.key !== undefined) return itemKeyAt(list, index) === anchor.key
      // By content as stored, so the server's copy of the same items still holds.
      return sameContent(
        anchor.siblings,
        list.filter((_, j) => j !== index),
      )
    }))

/**
 * The canopy path `restoreRemoval` puts a removal back at: a list item returns to its old index,
 * or to the list's end when the list is now shorter than that.
 */
export function restoredFieldPath(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  removal: FieldRemoval,
): CanopyPathSegment[] {
  if (removal.kind !== 'list-item') return removal.path
  const resolved = resolvePath(fields, value, removal.listPath)
  const list = resolved ? getAt(value, resolved.path) : undefined
  return [...removal.listPath, Math.min(removal.index, Array.isArray(list) ? list.length : 0)]
}

/** The enclosing lists of a removal in `value`, taken before the removal applies; see `anchors`. */
export function removalAnchors(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  removal: FieldRemoval,
): RemovalAnchor[] | undefined {
  return resolvePath(fields, value, removalPath(removal))?.lists.map(({ list, index }) => {
    const key = itemKeyAt(list, index)
    return key !== undefined
      ? { index, key }
      : { index, siblings: list.filter((_, j) => j !== index) }
  })
}

/** Where and what `restoreRemoval` writes, or undefined when it can't; see there. */
const planRestore = (
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  removal: FieldRemoval,
): { path: CanopyPathSegment[]; next: unknown } | undefined => {
  const resolved = resolvePath(fields, value, removalPath(removal))
  if (!resolved || !anchorsHold(removal.anchors, resolved.lists)) return undefined
  const { path } = resolved
  // An enclosing object cleared since would come back holding only this.
  if (!isPlainRecord(path.length > 1 ? getAt(value, path.slice(0, -1)) : value)) return undefined
  const current = getAt(value, path)
  let next: unknown
  if (removal.kind === 'list-item') {
    if (current !== undefined && current !== null && !Array.isArray(current)) return undefined
    // Already back (a Discard or Reload restored it, or an earlier Undo did).
    if (Array.isArray(current) && current.some((item) => sameContent(item, removal.item))) {
      return undefined
    }
    const list = Array.isArray(current) ? [...current] : []
    list.splice(Math.min(removal.index, list.length), 0, removal.item)
    next = list
  } else {
    if (current !== undefined && current !== null) return undefined
    next = removal.value
  }
  return { path, next }
}

/** Whether `restoreRemoval` would put the removal back, without building the restored value. */
export const canRestoreRemoval = (
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  removal: FieldRemoval,
): boolean => planRestore(fields, value, removal) !== undefined

/**
 * `value` with a removal put back, or undefined when it can't be: the list or field is gone,
 * another item holds an enclosing index, the item is already there, or the image field or object
 * has been filled. Edits made after the removal are kept, because it changes only the one list or
 * field, in the value as it is now.
 */
export function restoreRemoval(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  removal: FieldRemoval,
): Record<string, unknown> | undefined {
  const plan = planRestore(fields, value, removal)
  const restored = plan ? setAt(value, plan.path, plan.next) : undefined
  return isPlainRecord(restored) ? restored : undefined
}

/** Where a removal's moved threads went, said with its Undo; undefined when none moved. */
export const movedThreadsNote = (count: number): string | undefined =>
  count > 0
    ? `Its ${count === 1 ? 'comment thread' : `${count} comment threads`} moved to "Comment on this entry".`
    : undefined

/**
 * How many open field threads a removal at `path` moves to the entry: those inside it keyed to an
 * item at or below it. One keyed only above stays on its field, which a Clear leaves in place.
 */
export function openThreadsWithin(
  threads: readonly CommentThread[],
  entryPath: string,
  path: readonly CanopyPathSegment[],
): number {
  const prefix = parseCanopyPath(normalizeCanopyPath(path))
  const isIndex = (segment: CanopyPathSegment) => typeof segment === 'number'
  const itemsAbove = prefix.filter(isIndex).length - (isIndex(prefix[prefix.length - 1]) ? 1 : 0)
  return threads.filter((thread) => {
    if (thread.type !== 'field' || thread.resolved || thread.onRemovedItem) return false
    if (thread.entryPath !== entryPath || !thread.canopyPath) return false
    if ((thread.itemKeys?.length ?? 0) <= itemsAbove) return false
    const segments = parseCanopyPath(thread.canopyPath)
    return prefix.length <= segments.length && prefix.every((s, i) => segments[i] === s)
  }).length
}
