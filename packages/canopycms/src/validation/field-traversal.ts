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
 * Get the nested fields for a block template by looking up _type.
 */
function getBlockTemplateFields(
  blockField: BlockFieldConfig,
  item: Record<string, unknown>
): FieldConfig[] | undefined {
  const blockType = item._type as string | undefined
  if (!blockType) return undefined

  // Block fields use 'templates' property
  const template = blockField.templates?.find((t) => t.name === blockType)
  return template?.fields
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
  fields: FieldConfig[],
  data: Record<string, unknown>,
  visitor: FieldVisitor<T>,
  pathPrefix = ''
): T[] {
  const results: T[] = []

  for (const field of fields) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
    const value = data[field.name]

    // Skip undefined/null values
    if (value === undefined || value === null) continue

    // Let visitor handle this field first
    results.push(...visitor({ field, value, path: fieldPath }))

    // Then recurse into nested structures
    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      if (objectField.fields && typeof value === 'object' && !Array.isArray(value)) {
        results.push(
          ...traverseFields(
            objectField.fields,
            value as Record<string, unknown>,
            visitor,
            fieldPath
          )
        )
      }
    } else if (field.type === 'block') {
      const blockField = field as BlockFieldConfig
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object' && item !== null) {
            const blockFields = getBlockTemplateFields(blockField, item as Record<string, unknown>)
            if (blockFields) {
              results.push(
                ...traverseFields(
                  blockFields,
                  item as Record<string, unknown>,
                  visitor,
                  `${fieldPath}[${index}]`
                )
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
  fields: FieldConfig[],
  data: Record<string, unknown>,
  fieldType: string
): TraversalContext[] {
  return traverseFields(fields, data, (ctx) => {
    if (ctx.field.type === fieldType) {
      return [ctx]
    }
    return []
  })
}
