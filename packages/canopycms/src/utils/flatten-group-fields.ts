import type { FieldConfig, InlineGroupFieldConfig } from '../config'

/**
 * Recursively flatten inline groups out of a field array: group children are inlined at the
 * parent level, because groups are transparent to data.
 *
 * For data-layer iteration (reference resolution, change detection, body-field lookup) that
 * needs every data-carrying field without group wrappers. `traverseFields()` already handles
 * groups transparently and does not need this.
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
