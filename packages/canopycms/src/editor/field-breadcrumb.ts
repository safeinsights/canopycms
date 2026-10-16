import type { BlockFieldConfig, FieldConfig, ObjectFieldConfig } from '../config'
import { isPlainRecord } from '../validation/field-traversal'
import { parseCanopyPath } from './canopy-path'
import { listItemHeading } from './fields/list-item-title'
import { schemaLabel } from './schema-label'

/** Labels for an image field's parts, which `ImageField` reports errors on. */
const IMAGE_PART_LABELS = new Map([
  ['src', 'File'],
  ['alt', 'Alt text'],
  ['crop', 'Crop'],
  ['width', 'Width'],
  ['height', 'Height'],
])

/** The field named `name` in `fields`, looking inside inline groups, which add no path segment. */
const findField = (fields: readonly FieldConfig[], name: string): FieldConfig | undefined => {
  for (const field of fields) {
    if (field.type === 'group' && 'fields' in field) {
      const inner = findField(field.fields, name)
      if (inner) return inner
    } else if (field.name === name) {
      return field
    }
  }
  return undefined
}

/**
 * The human labels along a canopy path, for messages: `blocks[0].title` reads
 * `['Page sections', 'Hero', 'Heading']`. A block is named by its template's label and an
 * object-list item by its title (`listItemHeading`); a segment the schema doesn't know keeps its
 * raw name, so a stale path still reads. A block whose template isn't known (no `value`, or an
 * item that is gone) has its fields looked up in every template. `items: false` leaves the item
 * crumbs out, for a path whose indexes no longer say which item it was.
 */
export const fieldBreadcrumb = (
  fields: readonly FieldConfig[],
  value: unknown,
  path: string,
  { items = true }: { items?: boolean } = {},
): string[] => {
  const crumbs: string[] = []
  let scope: readonly FieldConfig[] | undefined = fields
  let current: unknown = value
  let field: FieldConfig | undefined

  for (const segment of parseCanopyPath(path)) {
    if (typeof segment === 'number') {
      const item: unknown = Array.isArray(current) ? current[segment] : undefined
      if (field?.type === 'block') {
        const block = isPlainRecord(item) ? item : {}
        const templateName = typeof block.template === 'string' ? block.template : undefined
        const templates = (field as BlockFieldConfig).templates
        const template = templates.find((t) => t.name === templateName)
        if (items)
          crumbs.push(template ? schemaLabel(template) : (templateName ?? `Item ${segment + 1}`))
        scope = template ? template.fields : templates.flatMap((t) => t.fields)
        current = block.value
      } else if (field?.type === 'object') {
        const objectField = field as ObjectFieldConfig
        if (items) crumbs.push(listItemHeading(item, objectField, segment))
        scope = objectField.fields
        current = item
      } else {
        if (items) crumbs.push(`Item ${segment + 1}`)
        scope = undefined
        current = item
      }
      field = undefined
      continue
    }

    const imagePart = field?.type === 'image' ? IMAGE_PART_LABELS.get(segment) : undefined
    if (imagePart) {
      crumbs.push(imagePart)
      field = undefined
      scope = undefined
      current = undefined
      continue
    }

    const found = scope ? findField(scope, segment) : undefined
    crumbs.push(found ? schemaLabel(found) : segment)
    current = isPlainRecord(current) ? current[segment] : undefined
    field = found
    scope =
      found?.type === 'object' && !found.list ? (found as ObjectFieldConfig).fields : undefined
  }
  return crumbs
}
