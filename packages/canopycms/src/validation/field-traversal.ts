/**
 * Shared field traversal utility for schema-aware data traversal.
 *
 * This module provides a generic way to traverse nested data structures
 * according to a schema, handling objects, blocks, and arrays with their
 * own schemas.
 */

import type {
  FieldConfig,
  ObjectFieldConfig,
  BlockFieldConfig,
  InlineGroupFieldConfig,
} from '../config'

/**
 * Context provided to the visitor function for each field.
 */
export interface TraversalContext {
  /** The field configuration from the schema */
  field: FieldConfig
  /** The value at this field in the data */
  value: unknown
  /** The dot-notation path to this field (e.g., "author.name" or "blocks[0].title") */
  path: string
}

/**
 * Visitor function that receives each field and can return results.
 * Return an empty array to skip this field, or return items to collect.
 */
export type FieldVisitor<T> = (context: TraversalContext) => T[]

/**
 * A block item resolved to its template fields and the data record that
 * holds the nested field values.
 */
export interface ResolvedBlockItem {
  /** The template's field schema */
  fields: FieldConfig[]
  /** The record containing the block's nested field values */
  data: Record<string, unknown>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve a block item to its template fields and nested data record.
 *
 * Real block data — as produced by the editor (BlockField.tsx) and persisted
 * by ContentStore — has the shape `{ template: string, value: {...} }`:
 * the template name lives on `template` and the nested field values live
 * under `value`. A `_type` discriminator with inline field values is also
 * accepted defensively (mirroring ai/json-to-markdown.ts).
 *
 * Returns undefined when the item has no resolvable template.
 */
export function resolveBlockItem(
  blockField: BlockFieldConfig,
  item: Record<string, unknown>,
): ResolvedBlockItem | undefined {
  const templateName =
    typeof item.template === 'string'
      ? item.template
      : typeof item._type === 'string'
        ? item._type
        : undefined
  if (!templateName) return undefined

  // Block fields use 'templates' property
  const template = blockField.templates?.find((t) => t.name === templateName)
  if (!template?.fields) return undefined

  // Nested field values live under `value` in the canonical shape; fall back
  // to the item itself for the inline `_type` shape.
  const data = isPlainRecord(item.value) ? item.value : item

  return { fields: template.fields, data }
}

/**
 * Recursively traverse fields in data according to schema.
 *
 * This function walks through data following the schema structure, calling
 * the visitor function for each field. It handles:
 * - Simple fields (string, number, boolean, reference, etc.)
 * - Object fields with nested schemas
 * - Block fields (arrays of typed objects with different schemas)
 * - Array fields containing objects with schemas
 *
 * @param fields - The schema fields to traverse
 * @param data - The data object to traverse
 * @param visitor - Function called for each field, returns items to collect
 * @param pathPrefix - Current path prefix for nested fields
 * @returns Array of all items returned by the visitor
 *
 * @example
 * ```ts
 * // Find all reference field values
 * const refs = traverseFields(schema, data, ({ field, value, path }) => {
 *   if (field.type === 'reference') {
 *     return [{ path, ids: Array.isArray(value) ? value : [value] }]
 *   }
 *   return []
 * })
 * ```
 */
export function traverseFields<T>(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
  visitor: FieldVisitor<T>,
  pathPrefix = '',
): T[] {
  const results: T[] = []

  for (const field of fields) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
    const value = data[field.name]

    // Inline groups are transparent to the data — their children live at the parent
    // data level, not under field.name, so skip the null/undefined guard for them.
    if (field.type === 'group') {
      results.push(
        ...traverseFields((field as InlineGroupFieldConfig).fields, data, visitor, pathPrefix),
      )
      continue
    }

    // Skip undefined/null values for all other field types
    if (value === undefined || value === null) continue

    // Let visitor handle this field first
    results.push(...visitor({ field, value, path: fieldPath }))

    // Then recurse into nested structures
    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      if (objectField.fields) {
        if (Array.isArray(value)) {
          // list: true — value is an array of objects
          value.forEach((item, index) => {
            if (typeof item === 'object' && item !== null) {
              results.push(
                ...traverseFields(
                  objectField.fields!,
                  item as Record<string, unknown>,
                  visitor,
                  `${fieldPath}[${index}]`,
                ),
              )
            }
          })
        } else if (typeof value === 'object' && value !== null) {
          results.push(
            ...traverseFields(
              objectField.fields,
              value as Record<string, unknown>,
              visitor,
              fieldPath,
            ),
          )
        }
      }
    } else if (field.type === 'block') {
      const blockField = field as BlockFieldConfig
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object' && item !== null) {
            const resolved = resolveBlockItem(blockField, item as Record<string, unknown>)
            if (resolved) {
              results.push(
                ...traverseFields(
                  resolved.fields,
                  resolved.data,
                  visitor,
                  `${fieldPath}[${index}]`,
                ),
              )
            }
          }
        })
      }
    }
  }

  return results
}

/**
 * Find all fields of a specific type in the data.
 *
 * @param fields - The schema fields
 * @param data - The data to search
 * @param fieldType - The field type to find (e.g., 'reference', 'string')
 * @returns Array of { field, value, path } for matching fields
 */
export function findFieldsByType(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
  fieldType: string,
): TraversalContext[] {
  return traverseFields(fields, data, (ctx) => {
    if (ctx.field.type === fieldType) {
      return [ctx]
    }
    return []
  })
}
