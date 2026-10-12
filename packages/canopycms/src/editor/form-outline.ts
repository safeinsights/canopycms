import type {
  BlockFieldConfig,
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
} from '../config'
import { isPlainRecord } from '../validation/field-traversal'
import { formatCanopyPath } from './canopy-path'
import type { OutlineItem } from './FormHeader'
import { listItemSecondary, listItemSummary } from './fields/list-item-title'

/**
 * The form's outline: each top-level field, then each row of a list or block field one level
 * down, in form order. An inline group is a heading, since it has no path of its own; its fields
 * follow it.
 */
export function buildFormOutline(
  fields: readonly FieldConfig[],
  value: Record<string, unknown>,
): OutlineItem[] {
  const items: OutlineItem[] = []
  const visit = (field: FieldConfig) => {
    if (field.type === 'group') {
      const group = field as InlineGroupFieldConfig
      items.push({ label: group.label ?? group.name, depth: 0 })
      group.fields.forEach(visit)
      return
    }
    items.push({ label: field.label ?? field.name, path: formatCanopyPath([field.name]), depth: 0 })
    const current = value[field.name]
    if (!Array.isArray(current)) return
    if (field.type === 'block') {
      const { templates } = field as BlockFieldConfig
      current.forEach((block: unknown, idx) => {
        const name =
          isPlainRecord(block) && typeof block.template === 'string' ? block.template : ''
        const template = templates.find((t) => t.name === name)
        items.push({
          label: template?.label ?? (name || 'Unknown block'),
          secondary:
            template && isPlainRecord(block)
              ? listItemSecondary(block.value, template.fields)
              : undefined,
          path: formatCanopyPath([field.name, idx]),
          depth: 1,
        })
      })
    } else if (field.type === 'object' && (field as ObjectFieldConfig).list) {
      current.forEach((item: unknown, idx) => {
        const { title, secondary } = listItemSummary(item, field as ObjectFieldConfig, idx)
        items.push({ label: title, secondary, path: formatCanopyPath([field.name, idx]), depth: 1 })
      })
    }
  }
  fields.forEach(visit)
  return items
}

/** True when some field, at any depth, is a block field or a list of objects. */
export function hasCollapsibleList(fields: readonly FieldConfig[]): boolean {
  return fields.some((field) => {
    if (field.type === 'block') return true
    if (field.type === 'group') return hasCollapsibleList((field as InlineGroupFieldConfig).fields)
    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      return objectField.list === true || hasCollapsibleList(objectField.fields)
    }
    return false
  })
}
