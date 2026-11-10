/**
 * "Undo change" in the "Show changes" drawer: one saved change of an entry set back, in its form
 * value, to how `source` has it: the base's version to undo it, the branch's saved one to redo it.
 * Pure; the editor puts the result in the entry's draft, so an undo is an unsaved edit until saved.
 * List and block items are found by item key, so an undo lands on the item the change named
 * wherever it now sits, and an item put back keeps its key and with it its comment threads.
 */

import type { EntryChangeSide } from '../api/branch-entry-changes'
import { ITEM_KEY } from '../item-keys'
import { isPlainRecord } from '../validation/field-traversal'
import type { CanopyPathSegment } from './canopy-path'
import type { DataPathSegment, EntryChange } from './entry-diff'

type FormValue = Record<string, unknown>

/** The form key of an md/mdx body, which the diff names by the schema's body field. */
const FORM_BODY_KEY = 'body'

/** A side as the editor's form holds it: an md/mdx body under `body` (`normalizeContentPayload`). */
export const formValueOfSide = (side: EntryChangeSide): FormValue =>
  side.body === undefined ? { ...side.data } : { ...side.data, [FORM_BODY_KEY]: side.body }

/** A form value as a side shaped like `like`, for comparing it with the base. */
export const sideOfFormValue = (value: FormValue, like: EntryChangeSide): EntryChangeSide => {
  if (like.body === undefined) return { ...like, data: value }
  const { [FORM_BODY_KEY]: body, ...data } = value
  return { ...like, data, body: typeof body === 'string' ? body : '' }
}

const indexOfKey = (list: readonly unknown[], key: string): number =>
  list.findIndex((item) => isPlainRecord(item) && item[ITEM_KEY] === key)

/** A change's data path in form keys: the body field, when it heads the path, is `body`. */
const formPath = (change: EntryChange, bodyField: string | undefined): DataPathSegment[] => {
  const path = change.dataPath ?? []
  const head = path[0]
  return bodyField && head && 'field' in head && head.field === bodyField
    ? [{ field: FORM_BODY_KEY }, ...path.slice(1)]
    : path
}

const step = (value: unknown, segment: DataPathSegment): unknown => {
  if ('field' in segment) return isPlainRecord(value) ? value[segment.field] : undefined
  if ('item' in segment) {
    if (!Array.isArray(value)) return undefined
    const index = indexOfKey(value, segment.item)
    return index < 0 ? undefined : value[index]
  }
  return isPlainRecord(value) ? (isPlainRecord(value.value) ? value.value : value) : undefined
}

const valueAt = (value: unknown, path: readonly DataPathSegment[]): unknown =>
  path.reduce(step, value)

/**
 * `value` with what is at `path` replaced by `replace`'s result, copied on the way down; a
 * record missing on the way is made, so a field comes back inside an object the branch cleared.
 * Undefined when the path leads through an item or block the value no longer has. A record
 * member replaced by undefined is dropped.
 */
const updateAt = (
  value: unknown,
  path: readonly DataPathSegment[],
  replace: (old: unknown) => unknown,
): { value: unknown } | undefined => {
  if (path.length === 0) return { value: replace(value) }
  const [segment, ...rest] = path
  if ('field' in segment) {
    const record = isPlainRecord(value) ? value : value == null ? {} : undefined
    if (!record) return undefined
    const next = updateAt(record[segment.field], rest, replace)
    if (!next) return undefined
    const out = { ...record }
    if (next.value === undefined) delete out[segment.field]
    else out[segment.field] = next.value
    return { value: out }
  }
  if ('item' in segment) {
    if (!Array.isArray(value)) return undefined
    const index = indexOfKey(value, segment.item)
    if (index < 0) return undefined
    const next = updateAt(value[index], rest, replace)
    if (!next) return undefined
    const out = [...value]
    out[index] = next.value
    return { value: out }
  }
  if (!isPlainRecord(value)) return undefined
  if (!isPlainRecord(value.value)) return updateAt(value, rest, replace)
  const next = updateAt(value.value, rest, replace)
  return next && { value: { ...value, value: next.value } }
}

/**
 * `item` placed in `list` (which lacks it) where `order` has it: after the nearest item before it
 * in `order` that `list` holds, else first.
 */
const placeLike = (list: readonly unknown[], item: unknown, key: string, order: unknown[]) => {
  const at = indexOfKey(order, key)
  for (let i = at - 1; i >= 0; i--) {
    const before = order[i]
    const index = isPlainRecord(before) ? indexOfKey(list, before[ITEM_KEY] as string) : -1
    if (index >= 0) return [...list.slice(0, index + 1), item, ...list.slice(index + 1)]
  }
  return [item, ...list]
}

/** Whether a change has a place in the form value that an undo can set back. */
export const canSetBack = (change: EntryChange): boolean => change.dataPath !== undefined

/**
 * `current` with `change` set to how `source` has it. A whole item added or removed is put in or
 * taken out; a moved item goes back beside its neighbours in `source`; anything else takes
 * `source`'s value at the change's path. Undefined when the change can't be placed in `current`,
 * such as a field inside an item `current` no longer has. `bodyField` is the schema's body field
 * on an md/mdx entry.
 */
export function setChangeBack(
  current: FormValue,
  source: FormValue,
  change: EntryChange,
  bodyField?: string,
): FormValue | undefined {
  if (!canSetBack(change)) return undefined
  const path = formPath(change, bodyField)
  const last = path[path.length - 1]
  let next: { value: unknown } | undefined
  if (change.item && last && 'item' in last) {
    const listPath = path.slice(0, -1)
    const order = valueAt(source, listPath)
    const sourceList = Array.isArray(order) ? order : []
    const wanted = valueAt(source, path)
    next = updateAt(current, listPath, (old) => {
      const list = Array.isArray(old) ? old : []
      const index = indexOfKey(list, last.item)
      if (wanted === undefined) return index < 0 ? old : list.filter((_, i) => i !== index)
      if (change.kind === 'moved') {
        if (index < 0) return old
        const without = list.filter((_, i) => i !== index)
        return placeLike(without, list[index], last.item, sourceList)
      }
      return index >= 0 ? old : placeLike(list, structuredClone(wanted), last.item, sourceList)
    })
  } else {
    const wanted = valueAt(source, path)
    next = updateAt(current, path, () =>
      wanted === undefined ? undefined : structuredClone(wanted),
    )
  }
  return next && isPlainRecord(next.value) ? next.value : undefined
}

/**
 * The canopy path (`blocks[2].title`) of a change in `value`, which comment threads anchor to;
 * undefined when an item on it isn't in `value`.
 */
export function canopyPathOf(
  value: FormValue,
  change: EntryChange,
  bodyField?: string,
): CanopyPathSegment[] | undefined {
  const out: CanopyPathSegment[] = []
  let at: unknown = value
  for (const segment of formPath(change, bodyField)) {
    if ('item' in segment) {
      const index = Array.isArray(at) ? indexOfKey(at, segment.item) : -1
      if (index < 0) return undefined
      out.push(index)
    } else if ('field' in segment) {
      out.push(segment.field)
    }
    at = step(at, segment)
  }
  return out
}

/** An item change's place in `source`'s list: -1 for an item `source` lacks; undefined otherwise. */
const sourcePosition = (
  source: FormValue,
  change: EntryChange,
  bodyField: string | undefined,
): number | undefined => {
  if (!change.item) return undefined
  const path = formPath(change, bodyField)
  const last = path[path.length - 1]
  if (!last || !('item' in last)) return undefined
  const list = valueAt(source, path.slice(0, -1))
  return Array.isArray(list) ? indexOfKey(list, last.item) : -1
}

/**
 * `current` with every one of `changes` set to how `source` has it, leaving anything else, such
 * as an unsaved edit to an unchanged field, as it is. Items are placed in `source`'s order, so
 * each lands beside a neighbour already back in place and the list ends in `source`'s order. A
 * change that can't be placed is skipped.
 */
export function setAllBack(
  current: FormValue,
  source: FormValue,
  changes: readonly EntryChange[],
  bodyField?: string,
): FormValue {
  const ordered = changes
    .map((change) => ({ change, position: sourcePosition(source, change, bodyField) }))
    .sort((a, b) => (a.position ?? -2) - (b.position ?? -2))
  return ordered.reduce(
    (value, { change }) => setChangeBack(value, source, change, bodyField) ?? value,
    current,
  )
}
