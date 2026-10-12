import type {
  BlockFieldConfig,
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
} from '../config'
import { isPlainRecord } from '../validation/field-traversal'
import { formatCanopyPath } from './canopy-path'
import type { OutlineNode } from './FormHeader'
import { listItemSecondary, listItemSummary } from './fields/list-item-title'

/**
 * The form's outline: each top-level field in form order, holding the rows of a list or block
 * field. An inline group holds its fields and has no path, since it is not a field. A type in
 * `customTypes` has a custom renderer, so it holds no rows.
 */
export function buildFormOutline(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
  customTypes: ReadonlySet<string> = new Set(),
): OutlineNode[] {
  const rowsOf = (field: FieldConfig): OutlineNode[] | undefined => {
    const current = value[field.name]
    // A custom renderer draws its own rows, which carry no row paths.
    if (!Array.isArray(current) || customTypes.has(field.type)) return undefined
    if (field.type === 'block') {
      const { templates } = field as BlockFieldConfig
      return current.map((block: unknown, idx) => {
        const name =
          isPlainRecord(block) && typeof block.template === 'string' ? block.template : ''
        const template = templates.find((t) => t.name === name)
        return {
          label: template?.label ?? (name || 'Unknown block'),
          secondary:
            template && isPlainRecord(block)
              ? listItemSecondary(block.value, template.fields)
              : undefined,
          path: formatCanopyPath([field.name, idx]),
        }
      })
    }
    if (field.type === 'object' && (field as ObjectFieldConfig).list) {
      return current.map((item: unknown, idx) => {
        const { title, secondary } = listItemSummary(item, field as ObjectFieldConfig, idx)
        return { label: title, secondary, path: formatCanopyPath([field.name, idx]) }
      })
    }
    return undefined
  }
  const nodeOf = (field: FieldConfig): OutlineNode => {
    if (field.type === 'group') {
      const group = field as InlineGroupFieldConfig
      return { label: group.label ?? group.name, children: group.fields.map(nodeOf) }
    }
    return {
      label: field.label ?? field.name,
      path: formatCanopyPath([field.name]),
      children: rowsOf(field),
    }
  }
  return fields.map(nodeOf)
}

/**
 * True when some field, at any depth, is a block field or a list of objects that the form draws
 * itself: a type in `customTypes` has a custom renderer.
 */
export function hasCollapsibleList(
  fields: readonly FieldConfig[],
  customTypes: ReadonlySet<string> = new Set(),
): boolean {
  return fields.some((field) => {
    if (customTypes.has(field.type)) return false
    if (field.type === 'block') return true
    if (field.type === 'group') {
      return hasCollapsibleList((field as InlineGroupFieldConfig).fields, customTypes)
    }
    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      return objectField.list === true || hasCollapsibleList(objectField.fields, customTypes)
    }
    return false
  })
}
