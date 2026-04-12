import type { FieldConfig, InlineGroupFieldConfig } from '../config'

/**
 * Recursively flatten inline groups out of a field array.
 * Group children are inlined at the parent level — groups are transparent to data.
 *
 * Use this when iterating fields for data-layer purposes (reference resolution,
 * change detection, body-field lookup, etc.) where you need all data-carrying
 * fields without group wrappers.
 *
 * Not needed when using traverseFields() — that already handles groups transparently.
 */
export function flattenGroupFields(fields: readonly FieldConfig[]): FieldConfig[] {
  const result: FieldConfig[] = []
  for (const field of fields) {
    if (field.type === 'group') {
      result.push(...flattenGroupFields((field as InlineGroupFieldConfig).fields))
    } else {
      result.push(field)
    }
  }
  return result
}
