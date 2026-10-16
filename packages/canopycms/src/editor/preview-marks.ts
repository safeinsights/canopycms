import type { BlockFieldConfig, FieldConfig, ObjectFieldConfig } from '../config'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { resolveBlockItem } from '../validation/field-traversal'
import { formatCanopyPath, normalizeCanopyPath, parseCanopyPath } from './canopy-path'

/** A preview mark whose path names no field of the entry, and the closest path that does. */
export interface InexactMark {
  /** The mark's path, normalized. */
  path: string
  /** Its longest prefix that names a field, absent when not even the first segment does. */
  nearest?: string
}

/** Where a path has got to; `unknown` is a block item the draft lacks, taking every path. */
type Position =
  | { kind: 'record'; fields: readonly FieldConfig[]; data: unknown }
  | { kind: 'items'; field: FieldConfig; data: unknown }
  | { kind: 'blocks'; field: BlockFieldConfig; data: unknown }
  | { kind: 'leaf' }
  | { kind: 'unknown' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const itemAt = (list: unknown, index: number): unknown =>
  Array.isArray(list) ? list[index] : undefined

const enterField = (field: FieldConfig, value: unknown): Position => {
  if (field.type === 'block')
    return { kind: 'blocks', field: field as BlockFieldConfig, data: value }
  if ('list' in field && field.list) return { kind: 'items', field, data: value }
  if (field.type === 'object') {
    return { kind: 'record', fields: (field as ObjectFieldConfig).fields, data: value }
  }
  return { kind: 'leaf' }
}

const step = (position: Position, segment: string | number): Position | undefined => {
  switch (position.kind) {
    case 'unknown':
      return position
    case 'leaf':
      return undefined
    case 'record': {
      if (typeof segment !== 'string') return undefined
      const field = flattenGroupFields(position.fields).find((f) => f.name === segment)
      if (!field) return undefined
      return enterField(field, isRecord(position.data) ? position.data[segment] : undefined)
    }
    case 'items': {
      if (typeof segment !== 'number') return undefined
      if (position.field.type !== 'object') return { kind: 'leaf' }
      const fields = (position.field as ObjectFieldConfig).fields
      return { kind: 'record', fields, data: itemAt(position.data, segment) }
    }
    case 'blocks': {
      if (typeof segment !== 'number') return undefined
      const item = itemAt(position.data, segment)
      const resolved = isRecord(item) ? resolveBlockItem(position.field, item) : undefined
      return resolved ? { kind: 'record', ...resolved } : { kind: 'unknown' }
    }
  }
}

/**
 * The marks naming no field: a key the schema lacks, a segment below a reference, image or
 * scalar, or another template's field. Walks the schema, not the form's DOM, which leaves out
 * collapsed fields; the draft only picks a block item's template, and an item it lacks takes
 * every path, since marks can trail a draft by one report.
 */
export const findInexactMarks = (
  fields: readonly FieldConfig[],
  data: unknown,
  paths: readonly string[],
): InexactMark[] => {
  const inexact = new Map<string, InexactMark>()
  for (const raw of paths) {
    const path = normalizeCanopyPath(raw)
    const segments = parseCanopyPath(path)
    let position: Position | undefined = { kind: 'record', fields, data }
    let matched = 0
    for (const segment of segments) {
      position = step(position, segment)
      if (!position) break
      matched++
    }
    if (position && segments.length > 0) continue
    inexact.set(path, {
      path,
      ...(matched > 0 ? { nearest: formatCanopyPath(segments.slice(0, matched)) } : {}),
    })
  }
  return [...inexact.values()]
}
